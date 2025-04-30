import json
import asyncio
import time
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import os
import sys

# Track capture status for each agent
  # {hostname: {"capture": False, "reset": False}}


app = FastAPI()

# Enable CORS for frontend access
origins = ["http://localhost:3000", "https://admin-soc-tool.vercel.app"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Set up the base path: use the executable directory if bundled, else the script directory.
if getattr(sys, "frozen", False):
    base_path = os.path.dirname(sys.executable)
else:
    base_path = os.path.dirname(os.path.abspath(__file__))

# Use an absolute path for the persistence file
PERSISTENCE_FILE = os.path.join(base_path, "agents.json")

# In-memory storage for pending and approved agents and tokens
pending_agents = {}      # {hostname: ip_address}
approved_agents = {}     # {hostname: ip_address}
agent_tokens = {}        # {hostname: token}

# Global variable to store the latest metrics (system + packets) received from agents
all_metrics = {}         # { hostname: { "data": {...}, "packets": [...] } }
capture_status = {}
# Map to track packet capture status per agent
capture_commands = {}  # {hostname: "start" or "stop"}

# ================== PERSISTENCE FUNCTIONS ==================
def load_persistence():
    global approved_agents, agent_tokens
    if os.path.exists(PERSISTENCE_FILE):
        try:
            with open(PERSISTENCE_FILE, "r") as f:
                content = f.read().strip()
                if not content:
                    # File is empty – initialize empty data
                    approved_agents = {}
                    agent_tokens = {}
                    print("[PERSISTENCE] No data found; starting fresh.")
                else:
                    data = json.loads(content)
                    approved_agents = data.get("approved_agents", {})
                    agent_tokens = data.get("agent_tokens", {})
                    print("[PERSISTENCE] Loaded approved agents and tokens.")
        except json.JSONDecodeError:
            print("[PERSISTENCE] Error decoding JSON; using empty data.")
            approved_agents = {}
            agent_tokens = {}


def save_persistence():
    data = {
        "approved_agents": approved_agents,
        "agent_tokens": agent_tokens,
    }
    try:
        with open(PERSISTENCE_FILE, "w") as f:
            json.dump(data, f, indent=4)
        print("[PERSISTENCE] Saved approved agents and tokens.")
    except Exception as e:
        print(f"[PERSISTENCE] Error saving data: {e}")


load_persistence()


# ================== DATA MODELS ==================
class RegisterRequest(BaseModel):
    hostname: str
    ip_address: str


class ApproveRequest(BaseModel):
    hostname: str


class RejectRequest(BaseModel):
    hostname: str


# ================== AGENT REGISTRATION ==================
@app.post("/register")
def register_agent(request: RegisterRequest):
    """Agent requests approval."""
    if request.hostname in approved_agents:
        return {"status": "approved", "token": agent_tokens[request.hostname]}

    if request.hostname in pending_agents:
        return {"status": "pending", "message": "Awaiting admin approval."}

    pending_agents[request.hostname] = request.ip_address
    print(f"[REGISTER] New agent pending approval: {request.hostname} ({request.ip_address})")
    return {"status": "pending", "message": "Awaiting admin approval."}


# ================== ADMIN APPROVAL ==================
@app.get("/pending")
def get_pending_agents():
    """Returns a list of agents waiting for approval."""
    return pending_agents


@app.post("/approve")
def approve_agent(request: ApproveRequest):
    """Admin approves an agent, moving it to the approved list and generating a token."""
    if request.hostname in approved_agents:
        token = agent_tokens.get(request.hostname)
        return {"status": "already_approved", "token": token}

    if request.hostname not in pending_agents:
        raise HTTPException(status_code=404, detail="Device not found in pending list.")

    approved_agents[request.hostname] = pending_agents.pop(request.hostname)
    token = f"TOKEN_{request.hostname}_{int(time.time())}"
    agent_tokens[request.hostname] = token
    save_persistence()

    print(f"[APPROVE] Device {request.hostname} approved. Assigned token: {token}")
    return {"status": "approved", "token": token}


@app.post("/reject")
def reject_agent(request: RejectRequest):
    """Admin rejects an agent, removing it from the pending list."""
    if request.hostname not in pending_agents:
        raise HTTPException(status_code=404, detail="Device not found in pending list.")

    del pending_agents[request.hostname]
    print(f"[REJECT] Device {request.hostname} rejected.")
    return {"status": "rejected", "message": "Device has been denied access."}


# ================== METRICS ENDPOINT ==================
@app.post("/metrics")
async def receive_metrics(request: Request):
    """
    Agents now POST both:
      - 'data': the system‑info dict
      - 'packets': an array of packet entries
    We validate and then store both together under all_metrics[hostname].
    """
    try:
        payload = await request.json()
    except Exception as e:
        print(f"[ERROR] Failed to parse JSON: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON")

    hostname = payload.get("hostname")
    token = request.headers.get("Authorization", "").replace("Bearer ", "")

    # Auth checks
    if not hostname or hostname not in approved_agents:
        raise HTTPException(status_code=403, detail="Unauthorized agent.")
    expected = agent_tokens.get(hostname)
    if not expected or token != expected:
        raise HTTPException(status_code=403, detail="Invalid token.")

    # Pull out system info + packets
    system_data = payload.get("data", {})
    packets = payload.get("packets", [])

    # Store together
    all_metrics[hostname] = {
        "data": system_data,
        "packets": packets,
    }
    
    print(f"[DATA] Received from {hostname}: {len(packets)} packets + system info")
    print("[DEBUG] all_metrics snapshot:", json.dumps(all_metrics, indent=2))
    return {"status": "success", "message": "Data received"}

@app.post("/start-capture")
async def start_capture(request: Request):
    try:
        payload = await request.json()
        hostname = payload.get("hostname")
        if not hostname or hostname not in approved_agents:
            raise HTTPException(status_code=404, detail="Invalid hostname.")
        capture_commands[hostname] = "start"
        print(f"[CONTROL] Start capture requested for {hostname}")
        return {"status": "started"}
    except Exception as e:
        print(f"[ERROR] Failed to start capture: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

@app.post("/stop-capture")
async def stop_capture(request: Request):
    try:
        payload = await request.json()
        hostname = payload.get("hostname")
        if not hostname or hostname not in approved_agents:
            raise HTTPException(status_code=404, detail="Invalid hostname.")
        capture_commands[hostname] = "stop"
        print(f"[CONTROL] Stop capture requested for {hostname}")
        return {"status": "stopped"}
    except Exception as e:
        print(f"[ERROR] Failed to stop capture: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

@app.post("/clear-capture")
async def clear_capture(request: Request):
    try:
        payload = await request.json()
        hostname = payload.get("hostname")
        if not hostname or hostname not in approved_agents:
            raise HTTPException(status_code=404, detail="Invalid hostname.")
        capture_commands[hostname] = "clear"
        print(f"[CONTROL] Clear capture requested for {hostname}")
        return {"status": "cleared"}
    except Exception as e:
        print(f"[ERROR] Failed to clear capture: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")


# ================== APPROVED LIST ==================
@app.get("/approved")
def get_approved_agents():
    """Returns a dictionary of approved agents."""
    return approved_agents


# ================== METRICS STREAM ==================
async def stream_metrics():
    while True:
        # Include capture commands in the streamed data
        data = {
            "metrics": all_metrics,
            "commands": capture_commands
        }
        yield f"data: {json.dumps(data)}\n\n"
        await asyncio.sleep(1)

@app.get("/commands")
def get_agent_command(hostname: str):
    """Allow agent to poll current capture command."""
    if not hostname or hostname not in approved_agents:
        raise HTTPException(status_code=403, detail="Invalid hostname.")
    return {"command": capture_commands.get(hostname, "stop")}


@app.get("/metrics-stream")
def metrics_stream():
    """Endpoint for the frontend to subscribe to real-time metrics updates."""
    return StreamingResponse(stream_metrics(), media_type="text/event-stream")

# ================== CONTROL ENDPOINTS ==================
from fastapi import Body


if __name__ == "__main__":
    # Run without reload for production or bundled exe
    uvicorn.run("server:app", host="0.0.0.0", port=8123)
