import threading
import time
import signal
import socket
import httpx
import ctypes
import json
import sys
import os
from system_info import get_system_info
from packet_capture import start_sniff, stop_sniff, get_captured_packets, reset_packet_buffer, stop_sniff


# hide console window
hwnd = ctypes.windll.kernel32.GetConsoleWindow()
if hwnd:
    ctypes.windll.user32.ShowWindow(hwnd, 0)

# ensure stdout/stderr have a fileno()
for name in ('stdout', 'stderr'):
    stream = getattr(sys, name)
    if stream is None or not hasattr(stream, 'fileno'):
        setattr(sys, name, open(os.devnull, 'w'))

try:
    import __builtin__  # python2 shim
except ImportError:
    import builtins as __builtin__

from system_info import get_system_info
from packet_capture import start_sniff, get_captured_packets


def main():
    import tkinter as tk
    from tkinter import messagebox
    import threading
    import httpx
    import socket
    import json
    import time
    import signal

    CONFIG_FILE = 'agent_config.json'
    running = False
    agent_thread = None

    def save_config(data):
        try:
            with open(CONFIG_FILE, 'w') as f:
                json.dump(data, f, indent=4)
        except Exception:
            pass

    def load_config():
        if not os.path.exists(CONFIG_FILE):
            save_config({})
        try:
            with open(CONFIG_FILE, 'r') as f:
                s = f.read().strip()
                return json.loads(s) if s else {}
        except:
            save_config({})
            return {}

    def get_server_url():
        cfg = load_config()
        ip = cfg.get('server_ip', 'localhost')
        return f'http://{ip}:8123'

    def handle_exit(signum, frame):
        nonlocal running
        running = False
        os._exit(0)

    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)

    def get_device_info():
        hn = socket.gethostname()
        try:
            ip = socket.gethostbyname(hn)
        except:
            ip = 'Unknown'
        return {'hostname': hn, 'ip_address': ip}

    def request_approval():
        info = get_device_info()
        cfg = load_config()
        if 'token' in cfg:
            return cfg['token']
        try:
            r = httpx.post(f"{get_server_url()}/register", json=info, timeout=5)
            if r.status_code == 200 and r.json().get('status') == 'approved':
                token = r.json().get('token')
                cfg['token'] = token
                save_config(cfg)
                return token
        except:
            time.sleep(3)
        return None

    def send_system_info():
        cfg = load_config()
        token = cfg.get('token') or request_approval()
        if not token:
            time.sleep(3)
            return
        hostname = get_device_info()['hostname']
        payload = {
            'hostname': hostname,
            'data': get_system_info(),
            'packets': get_captured_packets()[:5000],
        }
        print(f"[DEBUG] Sending {len(payload['packets'])} packets to server")

        headers = {'Authorization': f'Bearer {token}'}
        try:
            httpx.post(f"{get_server_url()}/metrics", json=payload, headers=headers, timeout=5)
        except:
            time.sleep(3)

    def agent_loop():
        nonlocal running
        was_running = False

        while running:
            cfg = load_config()
            token = cfg.get('token') or request_approval()
            if not token:
                time.sleep(3)
                continue

            hostname = get_device_info()['hostname']

            try:
                # Ask server what to do
                r = httpx.get(f"{get_server_url()}/commands", params={"hostname": hostname}, timeout=5)
                cmd = r.json().get("command", "")

                if cmd == "start" and not was_running:
                    print("[AGENT] Starting packet capture")
                    start_sniff()
                    was_running = True

                elif cmd == "stop" and was_running:
                    print("[AGENT] Stopping packet capture")
                    stop_sniff()
                    was_running = False

                elif cmd == "clear":
                    print("[AGENT] Clearing packet buffer")
                    reset_packet_buffer()

            except Exception as e:
                print(f"[ERROR] Command fetch failed: {e}")
                time.sleep(3)


            send_system_info()
            time.sleep(1)




    def start_agent():
        nonlocal running, agent_thread
        if running:
            messagebox.showinfo('Info', 'Agent already running')
            return
        running = True
        agent_thread = threading.Thread(target=agent_loop, daemon=True)
        agent_thread.start()
        messagebox.showinfo('Info', 'Agent started')

    def stop_agent():
        nonlocal running
        if not running:
            messagebox.showinfo('Info', 'Agent not running')
            return
        running = False
        os._exit(0)

    # GUI setup
    root = tk.Tk()
    root.title('Agent Configuration')
    frame = tk.Frame(root, padx=10, pady=10)
    frame.pack()

    placeholder = '192.168.1.1'
    cfg = load_config()
    tk.Label(frame, text='Server IP:').grid(row=0, column=0)
    entry = tk.Entry(frame, fg='grey')
    entry.grid(row=0, column=1)
    if cfg.get('server_ip'):
        entry.insert(0, cfg['server_ip'])
        entry.config(fg='black')
    else:
        entry.insert(0, placeholder)

    def save_and_notify():
        ip = entry.get().strip()
        if not ip or ip == placeholder:
            messagebox.showerror('Error', 'Server IP cannot be empty')
            return
        c = load_config()
        c['server_ip'] = ip
        save_config(c)
        messagebox.showinfo('Info', f'Saved: {ip}')

    entry.bind('<FocusIn>', lambda e: entry.delete(0, 'end') or entry.config(fg='black') if entry.get() == placeholder else None)
    entry.bind('<FocusOut>', lambda e: entry.insert(0, placeholder) or entry.config(fg='grey') if not entry.get() else None)

    tk.Button(frame, text='Save Config', command=save_and_notify).grid(row=1, column=0, columnspan=2)
    tk.Button(frame, text='Start Agent', command=start_agent).grid(row=2, column=0)
    tk.Button(frame, text='Stop Agent', command=stop_agent).grid(row=2, column=1)

    root.mainloop()


if __name__ == '__main__':
    main()
