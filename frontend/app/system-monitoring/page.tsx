"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChartContainer, LineChart } from "@/components/ui/chart"
import {
  Cpu,
  Database,
  HardDrive,
  Network,
  Activity,
  Wifi,
  Server,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "next-themes"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import AgentApproval from "./agent_approval_component"

// --- Interfaces ---
interface NetworkSpeed {
  download_speed: number
  upload_speed: number
  ping: number | null
}

interface WiFiDetails {
  SSID: string | null
  "Signal Strength": string | null
}

interface CPUProcess {
  pid: number
  name: number | string
  cpu_percent: number
}

interface MemoryProcess {
  pid: number
  name: string
  memory_percent: number
}

interface ProcessDetails {
  Id: number
  SI: number
  ProcessName: string
  CPU: number
  Handles: number
  NPM: number
  PM: number
  WS: number
}

interface MetricsResponse {
  cpu_usage: number
  per_core_usage: number[]
  memory_usage: number
  disk_usage: number
  network_speed: NetworkSpeed
  wifi_details: WiFiDetails
  top_cpu_processes: CPUProcess[]
  top_memory_processes: MemoryProcess[]
  top_network_processes: { name: string; connections: number }[]
  process_details: ProcessDetails[] | string
  packets?: AgentPacket[]

}

interface Agent {
  hostname: string
  ip: string
}

// For the agent-captured packets table
interface AgentPacket {
  id: number
  time: string
  length: string
  sourceIp: string
  sourceMac: string
  sourcePort: string
  destIp: string
  destMac: string
  destPort: string
  protocol: string
  info?: string
}

// Chart data shape to satisfy the library’s requirement {timestamp: number, value: number}
interface ChartPoint {
  timestamp: number
  value: number
  [key: string]: any
}

// --- Initial state ---
const initialMetrics: MetricsResponse = {
  cpu_usage: 0,
  per_core_usage: [],
  memory_usage: 0,
  disk_usage: 0,
  network_speed: { download_speed: 0, upload_speed: 0, ping: 0 },
  wifi_details: { SSID: null, "Signal Strength": null },
  top_cpu_processes: [],
  top_memory_processes: [],
  top_network_processes: [],
  process_details: [],
}

// Maximum number of data points to keep in history
const MAX_HISTORY_POINTS = 30

export default function SystemDashboard() {
  const [mounted, setMounted] = useState(false)
  const [allMetrics, setAllMetrics] = useState<Record<string, MetricsResponse>>({})
  const [cpuHistories, setCpuHistories] = useState<Record<string, Array<{ timestamp: number; value: number }>>>({})
  const [coreHistories, setCoreHistories] = useState<Record<string, Array<Array<{ timestamp: number; value: number }>>>>(
    {}
  )
  const { theme, setTheme } = useTheme()
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "connecting" | "disconnected">("disconnected")
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string>("")
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)
  const [approvedAgents, setApprovedAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [showAgentApproval, setShowAgentApproval] = useState(false)

  // Agent-captured packets
  const [agentPackets, setAgentPackets] = useState<AgentPacket[]>([])
  const [packetsCleared, setPacketsCleared] = useState(false);


  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (selectedAgent) {
      console.log("Selected Agent:", selectedAgent)
      console.log("Selected Agent Metrics:", allMetrics[selectedAgent.hostname])
    }
  }, [allMetrics, selectedAgent])

  // Update CPU and core history when metrics change
  useEffect(() => {
    if (!allMetrics) return
    const newCpuHistories = { ...cpuHistories }
    const newCoreHistories = { ...coreHistories }

    Object.entries(allMetrics).forEach(([hostname, metrics]) => {
      const now = Date.now()

      // CPU history
      if (!newCpuHistories[hostname]) {
        newCpuHistories[hostname] = []
      }
      newCpuHistories[hostname] = [
        ...newCpuHistories[hostname],
        { timestamp: now, value: metrics.cpu_usage },
      ].slice(-MAX_HISTORY_POINTS)

      // Core history
      if (!newCoreHistories[hostname]) {
        newCoreHistories[hostname] = []
      }

      if (newCoreHistories[hostname].length === 0 && metrics.per_core_usage) {
        newCoreHistories[hostname] = metrics.per_core_usage.map(() => [])
      }

      if (metrics.per_core_usage) {
        metrics.per_core_usage.forEach((coreValue: number, coreIndex: number) => {
          if (!newCoreHistories[hostname][coreIndex]) {
            newCoreHistories[hostname][coreIndex] = []
          }
          newCoreHistories[hostname][coreIndex] = [
            ...newCoreHistories[hostname][coreIndex],
            { timestamp: now, value: coreValue },
          ].slice(-MAX_HISTORY_POINTS)
        })
      }
    })

    setCpuHistories(newCpuHistories)
    setCoreHistories(newCoreHistories)
  }, [allMetrics])

  // Fetch approved agents
  const fetchApprovedAgents = useCallback(async () => {
    try {
      const response = await fetch("http://localhost:8123/approved")
      if (response.ok) {
        const data = await response.json()
        const agents = Object.entries(data).map(([hostname, ip]) => ({
          hostname,
          ip: ip as string,
        }))
        setApprovedAgents(agents)
        if (agents.length > 0 && !selectedAgent) {
          setSelectedAgent(agents[0])
        }
      }
    } catch (err) {
      console.error("Error fetching approved agents:", err)
    }
  }, [selectedAgent])

  useEffect(() => {
    // Initial fetch of approved agents
    fetchApprovedAgents()

    // SSE for metrics
    const eventSource = new EventSource("http://localhost:8123/metrics-stream")
    setConnectionStatus("connecting")

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const rawMetrics = payload.metrics;  // Corrected
    
        const transformedData: Record<string, MetricsResponse> = {};
    
        Object.entries(rawMetrics).forEach(([hostname, agentObj]) => {
          const metrics = (agentObj as any).data as MetricsResponse;
          transformedData[hostname] = metrics;
    
          const packets = (agentObj as any).packets;
          if (hostname === selectedAgent?.hostname && Array.isArray(packets)) {
            if (!packetsCleared) {
              setAgentPackets(packets);
            }
          }
          
        });
    
        setAllMetrics(prev => ({ ...prev, ...transformedData }));
        setLastUpdated(new Date().toLocaleTimeString());
        setConnectionStatus("connected");
      } catch (e) {
        console.error("Error parsing metrics:", e);
        setConnectionStatus("disconnected");
        setError("Connection to server lost");
      }
    };
    
    
    
    
    eventSource.onerror = (err) => {
      console.error("EventSource failed:", err)
      setConnectionStatus("disconnected")
      setError("Connection to server lost")
    }

    return () => eventSource.close()
  }, [fetchApprovedAgents])

  // Demo of agentPackets

  const handleAgentApproved = useCallback(() => {
    fetchApprovedAgents()
  }, [fetchApprovedAgents])

  if (!mounted) return null

  const selectedAgentData = selectedAgent
    ? allMetrics[selectedAgent.hostname] ?? initialMetrics
    : initialMetrics

  const networkSpeed = selectedAgentData.network_speed ?? { download_speed: 0, upload_speed: 0, ping: 0 }
  const { download_speed, upload_speed, ping } = networkSpeed
  const pingValue = ping ?? 0

  // CPU chart data
  const cpuHistory = selectedAgent && cpuHistories[selectedAgent.hostname]
    ? cpuHistories[selectedAgent.hostname]
    : []

  const cpuChartData: ChartPoint[] = cpuHistory.map((point, index) => ({
    timestamp: index,
    value: point.value,
    fullTime: new Date(point.timestamp).toLocaleTimeString(),
  }))

  // Per-core chart data
  const coreHistory = selectedAgent && coreHistories[selectedAgent.hostname]
    ? coreHistories[selectedAgent.hostname]
    : []

  const coresChartData: ChartPoint[] = (() => {
    if (coreHistory.length === 0) return []
    const minLength = Math.min(...coreHistory.map((arr) => arr.length))
    return Array.from({ length: minLength }).map((_, i) => {
      // Provide a default "value=0" so it matches the shape {timestamp, value}
      const point: ChartPoint = {
        timestamp: i,
        value: 0, // Not used for multi-series, but required by the chart's type
        fullTime: new Date(coreHistory[0][i].timestamp).toLocaleTimeString(),
      }
      coreHistory.forEach((coreArr, coreIndex) => {
        // Put each core usage in a separate property
        point[`core${coreIndex}`] = coreArr[i].value
      })
      return point
    })
  })()

  // Format bytes
  const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i]
  }
  const handleStartCapture = async () => {
    if (!selectedAgent) return;
    await fetch("http://localhost:8123/start-capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: selectedAgent.hostname }),
    });
  };
  
  const handleStopCapture = async () => {
    if (!selectedAgent) return;
    await fetch("http://localhost:8123/stop-capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: selectedAgent.hostname }),
    });
  };
  
  const handleClearCapture = async () => {
    if (!selectedAgent) return;
  
    try {
      await fetch("http://localhost:8123/clear-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: selectedAgent.hostname }),
      });
  
      setAgentPackets([]); // Optimistically clear in UI
    } catch (err) {
      console.error("Failed to clear capture:", err);
    }
  };
  
  
  
  const handleSaveCapture = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(agentPackets, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `${selectedAgent?.hostname}_packets.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };
  
  return (
    <div className="container py-6 space-y-6">
      {/* Page Header */}
      <div className="flex flex-col space-y-3 md:flex-row md:justify-between md:items-center md:space-y-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Monitoring Dashboard</h1>
          <p className="text-muted-foreground">Real-time performance metrics and system analysis</p>
        </div>
        <div className="flex flex-col space-y-2 sm:flex-row sm:items-center sm:gap-2">
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setShowAgentApproval(!showAgentApproval)}>
            <Server className="h-4 w-4 mr-2" />
            Agent approval
          </Button>
          <div className="flex items-center gap-2 justify-center sm:justify-start">
            <div
              className={`h-3 w-3 rounded-full ${
                connectionStatus === "connected"
                  ? "bg-green-500"
                  : connectionStatus === "connecting"
                  ? "bg-yellow-500"
                  : "bg-red-500"
              }`}
            ></div>
            <span className="text-sm text-muted-foreground">{connectionStatus}</span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full sm:w-auto">
                {selectedAgent ? selectedAgent.hostname : "Select Agent"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {approvedAgents.map((agent) => (
                <DropdownMenuItem
                key={agent.hostname}
                onSelect={() => {
                  setSelectedAgent(agent);
                  setAgentPackets([]); // Clear previous agent's packets
                }}
              >
                {agent.hostname}
              </DropdownMenuItem>
              
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Agent Approval */}
      {showAgentApproval && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Server className="h-5 w-5 mr-2" />
              Agent Approval
            </CardTitle>
            <CardDescription>Approve or reject agent connection requests</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentApproval onAgentApproved={handleAgentApproved} />
          </CardContent>
        </Card>
      )}

      {/* If no agent selected */}
      {!selectedAgent ? (
        <div>Select an agent to view data.</div>
      ) : (
        <>
          {/* System Overview Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* CPU Card */}
            <Card className="bg-gradient-to-br from-blue-500/5 to-blue-500/10 border-blue-500/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center">
                  <Cpu className="h-5 w-5 mr-2 text-blue-500" />
                  CPU
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-end justify-between">
                  <div>
                    <span className="text-3xl font-bold">
                      {selectedAgentData.cpu_usage.toFixed(1)}%
                    </span>
                    <p className="text-sm text-muted-foreground">
                      {selectedAgentData.per_core_usage.length} Cores
                    </p>
                  </div>
                  <div className="h-16 w-24 flex items-end">
                    {selectedAgentData.per_core_usage.map((core: number, i: number) => (
                      <div
                        key={i}
                        className="flex-1 mx-0.5 bg-blue-500 rounded-t-sm"
                        style={{ height: `${core}%` }}
                      ></div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Memory Card */}
            <Card className="bg-gradient-to-br from-green-500/5 to-green-500/10 border-green-500/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center">
                  <Database className="h-5 w-5 mr-2 text-green-500" />
                  Memory
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-bold">
                      {selectedAgentData.memory_usage.toFixed(1)}%
                    </span>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">
                        {Array.isArray(selectedAgentData.process_details) ? selectedAgentData.process_details.length : 0} Active Processes
                      </p>
                    </div>
                  </div>
                  {/* Removed 'indicatorClassName' from Progress */}
                  <Progress
                    value={selectedAgentData.memory_usage}
                    className="h-2 bg-green-500/20"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Disk Card */}
            <Card className="bg-gradient-to-br from-purple-500/5 to-purple-500/10 border-purple-500/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center">
                  <HardDrive className="h-5 w-5 mr-2 text-purple-500" />
                  Disk
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-bold">{selectedAgentData.disk_usage.toFixed(1)}%</span>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">Storage Used</p>
                    </div>
                  </div>
                  {/* Removed 'indicatorClassName' from Progress */}
                  <Progress
                    value={selectedAgentData.disk_usage}
                    className="h-2 bg-purple-500/20"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Network Card */}
            <Card className="bg-gradient-to-br from-orange-500/5 to-orange-500/10 border-orange-500/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center">
                  <Network className="h-5 w-5 mr-2 text-orange-500" />
                  Network
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Download</span>
                    <span className="text-sm">{download_speed} MB/s</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Upload</span>
                    <span className="text-sm">{upload_speed} MB/s</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Ping</span>
                    <span className="text-sm">{pingValue.toFixed(1)} ms</span>
                  </div>
                  {selectedAgentData.wifi_details?.SSID && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">WiFi</span>
                      <span className="text-sm flex items-center">
                        <Wifi className="h-3 w-3 mr-1" />
                        {selectedAgentData.wifi_details.SSID}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* CPU Performance */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Cpu className="h-5 w-5 mr-2" />
                CPU Performance
              </CardTitle>
              <CardDescription>Real-time CPU usage monitoring and process analysis</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="overall">
                <TabsList className="mb-4 flex flex-wrap w-full">
                  <TabsTrigger value="overall" className="flex-1 text-xs sm:text-sm">
                    Overall Usage
                  </TabsTrigger>
                  <TabsTrigger value="cores" className="flex-1 text-xs sm:text-sm">
                    Per Core
                  </TabsTrigger>
                  <TabsTrigger value="processes" className="flex-1 text-xs sm:text-sm">
                    Processes
                  </TabsTrigger>
                </TabsList>

                {/* Overall Usage Tab */}
                <TabsContent value="overall">
                  <div className="flex flex-col space-y-6">
                    <div className="relative w-full">
                      <ChartContainer>
                        <LineChart
                          data={cpuChartData}
                          xAxisDataKey="timestamp"
                          series={[
                            {
                              dataKey: "value",
                              label: "CPU Usage",
                              color: "#3b82f6",
                            },
                          ]}
                          yAxisWidth={40}
                          showXAxis
                          showYAxis
                          showGrid
                          showTooltip
                          showLegend={false}
                          xAxisFormatter={(val) => `${val}s`}
                          yAxisFormatter={(val) => `${val.toFixed(0)}%`}
                        />
                      </ChartContainer>
                    </div>

                    {/* Some summary cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <Card className="bg-muted/40">
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-muted-foreground">Current Usage</p>
                              <p className="text-2xl font-bold">
                                {selectedAgentData.cpu_usage.toFixed(1)}%
                              </p>
                            </div>
                            <div className="h-12 w-12 rounded-full border-4 border-primary flex items-center justify-center">
                              <Cpu className="h-6 w-6 text-primary" />
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="bg-muted/40">
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-muted-foreground">Core Count</p>
                              <p className="text-2xl font-bold">
                                {selectedAgentData.per_core_usage.length}
                              </p>
                            </div>
                            <div className="h-12 w-12 rounded-full border-4 border-primary flex items-center justify-center">
                              <Server className="h-6 w-6 text-primary" />
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="bg-muted/40">
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-muted-foreground">Active Processes</p>
                              <p className="text-2xl font-bold">
                                {selectedAgentData.top_cpu_processes.length}
                              </p>
                            </div>
                            <div className="h-12 w-12 rounded-full border-4 border-primary flex items-center justify-center">
                              <Activity className="h-6 w-6 text-primary" />
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                </TabsContent>

                {/* Per Core Tab */}
                <TabsContent value="cores">
                  <div className="relative w-full mb-6 md:mb-8 lg:mb-10">
                    <ChartContainer>
                      <LineChart
                        data={coresChartData}
                        xAxisDataKey="timestamp"
                        series={coreHistory.map((_, index) => ({
                          dataKey: `core${index}`,
                          label: `Core ${index + 1}`,
                          color: `hsl(${index * 30}, 70%, 50%)`,
                          valueFormatter: (v) => `${v.toFixed(1)}%`,
                        }))}
                        yAxisWidth={40}
                        showXAxis
                        showYAxis
                        showGrid
                        showTooltip
                        showLegend
                        xAxisFormatter={(val) => `${val}s`}
                        yAxisFormatter={(val) => `${val.toFixed(0)}%`}
                      />
                    </ChartContainer>
                  </div>
                  <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                    {selectedAgentData.per_core_usage.map((usage: number, index: number) => (
                      <Card key={index} className="bg-muted/40">
                        <CardContent className="p-3">
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-medium text-muted-foreground">Core {index + 1}</p>
                              <Badge variant="outline" className="text-xs">
                                {usage.toFixed(1)}%
                              </Badge>
                            </div>
                            <Progress
                              value={usage}
                              className="h-1.5"
                            />
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </TabsContent>

                {/* Processes Tab */}
                <TabsContent value="processes">
                  <div className="rounded-md border">
                    <div className="relative w-full overflow-auto max-h-[400px]">
                      <table className="w-full caption-bottom text-xs sm:text-sm">
                        <thead className="sticky top-0 z-10 bg-card [&_tr]:border-b">
                          <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                            <th className="h-10 px-2 text-left align-middle font-medium">PID</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">Process Name</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">CPU (s)</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">Memory</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">Handles</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">NPM</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">PM</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">WS</th>
                            <th className="h-10 px-2 text-left align-middle font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody className="[&_tr:last-child]:border-0">
                          {(() => {
                            let processData: any[] = []
                            if (typeof selectedAgentData.process_details === "string") {
                              try {
                                processData = JSON.parse(selectedAgentData.process_details || "[]")
                              } catch (err) {
                                console.error("Error parsing process details:", err)
                                return (
                                  <tr>
                                    <td colSpan={9} className="p-4 text-center text-muted-foreground">
                                      Error loading process data. Please check the server logs.
                                    </td>
                                  </tr>
                                )
                              }
                            } else if (Array.isArray(selectedAgentData.process_details)) {
                              processData = selectedAgentData.process_details
                            }
                            return processData.length > 0 ? (
                              processData.map((proc) => (
                                <tr
                                  key={proc.Id}
                                  className="border-b transition-colors hover:bg-muted/50"
                                >
                                  <td className="p-2 align-middle">{proc.Id}</td>
                                  <td className="p-2 align-middle font-medium">{proc.ProcessName}</td>
                                  <td className="p-2 align-middle">
                                    <span>{proc.CPU ? proc.CPU.toFixed(1) : "0"}</span>
                                  </td>
                                  <td className="p-2 align-middle">
                                    {(proc.WS / 1024 / 1024).toFixed(1)} MB
                                  </td>
                                  <td className="p-2 align-middle">{proc.Handles}</td>
                                  <td className="p-2 align-middle font-medium">{proc.NPM}</td>
                                  <td className="p-2 align-middle font-medium">{proc.PM}</td>
                                  <td className="p-2 align-middle font-medium">{proc.WS}</td>
                                  <td className="p-2 align-middle">
                                    <Badge variant="outline" className="bg-green-500/10 text-green-500">
                                      Running
                                    </Badge>
                                  </td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td colSpan={9} className="p-4 text-center text-muted-foreground">
                                  No process data available
                                </td>
                              </tr>
                            )
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          {/* Memory & Network Details */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Memory */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Database className="h-5 w-5 mr-2" />
                  Memory Usage
                </CardTitle>
                <CardDescription>Memory allocation and top memory-consuming processes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Memory Usage</span>
                    <span className="text-sm font-medium">
                      {selectedAgentData.memory_usage.toFixed(1)}%
                    </span>
                  </div>
                  <Progress value={selectedAgentData.memory_usage} className="h-2" />
                </div>
                <div className="rounded-md border">
                  <div className="relative w-full overflow-auto max-h-[300px]">
                    <table className="w-full caption-bottom text-sm">
                      <thead className="[&_tr]:border-b sticky top-0 bg-background">
                        <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                          <th className="h-10 px-2 text-left align-middle font-medium">PID</th>
                          <th className="h-10 px-2 text-left align-middle font-medium">Process Name</th>
                          <th className="h-10 px-2 text-left align-middle font-medium">Memory %</th>
                        </tr>
                      </thead>
                      <tbody className="[&_tr:last-child]:border-0">
                        {selectedAgentData.top_memory_processes.length > 0 ? (
                          selectedAgentData.top_memory_processes.map((proc) => (
                            <tr key={proc.pid} className="border-b transition-colors hover:bg-muted/50">
                              <td className="p-2 align-middle">{proc.pid}</td>
                              <td className="p-2 align-middle font-medium">{proc.name}</td>
                              <td className="p-2 align-middle">
                                <div className="flex items-center">
                                  <div className="w-16 bg-muted rounded-full h-2 mr-2">
                                    <div
                                      className="bg-green-500 h-2 rounded-full"
                                      style={{ width: `${Math.min(proc.memory_percent, 100)}%` }}
                                    ></div>
                                  </div>
                                  <span>{proc.memory_percent.toFixed(1)}%</span>
                                </div>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={3} className="p-4 text-center text-muted-foreground">
                              No memory process data available
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Network */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Network className="h-5 w-5 mr-2" />
                  Network Activity
                </CardTitle>
                <CardDescription>Network performance metrics and connection details</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Card className="bg-muted/40">
                    <CardContent className="p-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">Download</p>
                        <p className="text-2xl font-bold">
                          {download_speed} <span className="text-sm font-normal">MB/s</span>
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="bg-muted/40">
                    <CardContent className="p-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">Upload</p>
                        <p className="text-2xl font-bold">
                          {upload_speed} <span className="text-sm font-normal">MB/s</span>
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="bg-muted/40">
                    <CardContent className="p-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">Ping</p>
                        <p className="text-2xl font-bold">
                          {pingValue.toFixed(1)} <span className="text-sm font-normal">ms</span>
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Agent-Captured Packets Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xl flex items-center">
                <Network className="mr-2 h-5 w-5" />
                Agent-Captured Packets
              </CardTitle>
              <CardDescription>Packets returned by the agent.exe from this device</CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {/* Control Buttons */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="default"
                  className="bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => handleStartCapture()}
                >
                  Start Capture
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleStopCapture()}
                >
                  Stop Capture
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleClearCapture()}
                >
                  Clear
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleSaveCapture()}
                >
                  Save As
                </Button>
              </div>

              {/* Table */}
              <div
                className="overflow-auto rounded-md"
                style={{ height: "calc(50vh)" }}
              >
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr>
                      <th className="p-2 border-b text-left">ID</th>
                      <th className="p-2 border-b text-left">Time</th>
                      <th className="p-2 border-b text-left">Length</th>
                      <th className="p-2 border-b text-left">Source IP</th>
                      <th className="p-2 border-b text-left">Source MAC</th>
                      <th className="p-2 border-b text-left">Source Port</th>
                      <th className="p-2 border-b text-left">Destination IP</th>
                      <th className="p-2 border-b text-left">Destination MAC</th>
                      <th className="p-2 border-b text-left">Destination Port</th>
                      <th className="p-2 border-b text-left">Protocol</th>
                      <th className="p-2 border-b text-left">Info</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentPackets.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="p-4 text-center text-muted-foreground">
                          No packets to display
                        </td>
                      </tr>
                    ) : (
                      agentPackets.map((pkt) => (
                        <tr
                          key={pkt.id}
                          className="border-b transition-colors hover:bg-muted/50"
                        >
                          <td className="p-2 align-middle">{pkt.id}</td>
                          <td className="p-2 align-middle whitespace-nowrap">{pkt.time}</td>
                          <td className="p-2 align-middle">{pkt.length}</td>
                          <td className="p-2 align-middle">{pkt.sourceIp}</td>
                          <td className="p-2 align-middle">{pkt.sourceMac}</td>
                          <td className="p-2 align-middle">{pkt.sourcePort}</td>
                          <td className="p-2 align-middle">{pkt.destIp}</td>
                          <td className="p-2 align-middle">{pkt.destMac}</td>
                          <td className="p-2 align-middle">{pkt.destPort}</td>
                          <td className="p-2 align-middle">
                            <Badge variant="outline">
                              {pkt.protocol}
                            </Badge>
                          </td>
                          <td className="p-2 align-middle">{pkt.info ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
