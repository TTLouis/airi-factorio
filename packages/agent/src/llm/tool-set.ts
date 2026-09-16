import { solveProductionTool } from './production-planning-tool'
import { tools } from './tools'
import { getTransportCapacityTool } from './transport-capacity-tool'

export const agentTools = [...tools, solveProductionTool, getTransportCapacityTool]
