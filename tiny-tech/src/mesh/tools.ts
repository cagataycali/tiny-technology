/**
 * mesh_* tools — the local agent's window into the zenoh mesh.
 * Direct port of devduck's zenoh_peer tool surface: peers/broadcast/send.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { MeshNode } from './zenoh.js'

export function makeMeshTools(mesh: MeshNode) {
  const meshPeers = tool({
    name: 'mesh_peers',
    description: 'List agents discovered on the zenoh mesh (devduck instances + tiny-tech nodes on this LAN / connected endpoints). Shows instance id, hostname, model, freshness.',
    inputSchema: z.object({}),
    callback: async () => {
      const peers = mesh.listPeers()
      if (!peers.length) return 'No peers discovered (mesh id: ' + mesh.instanceId + ')'
      const now = Date.now()
      return JSON.stringify({
        my_instance_id: mesh.instanceId,
        peers: peers.map((p) => ({
          id: p.instanceId, hostname: p.hostname, model: p.model,
          platform: p.platform, seen_seconds_ago: Math.round((now - p.lastSeen) / 1000),
        })),
      }, null, 2)
    },
  })

  const meshBroadcast = tool({
    name: 'mesh_broadcast',
    description: 'Send a command/question to EVERY agent on the mesh and collect their responses. Each peer runs it through its own agent with its own tools. Use for fan-out work or asking the fleet.',
    inputSchema: z.object({
      message: z.string().min(1).describe('Command or question for all peers'),
      wait_seconds: z.number().int().min(1).max(300).optional().describe('How long to wait for responses (default 60)'),
    }),
    callback: async ({ message, wait_seconds }) => {
      const results = await mesh.broadcast(message, (wait_seconds || 60) * 1000)
      if (!results.length) return 'No responses (timeout or no peers)'
      return results.map((r) => `── ${r.responder} ──\n${r.result}`).join('\n\n')
    },
  })

  const meshSend = tool({
    name: 'mesh_send',
    description: "Send a command/question to ONE specific mesh peer (id from mesh_peers). The remote agent executes with ITS local tools — e.g. run shell commands on another machine.",
    inputSchema: z.object({
      peer_id: z.string().min(1).describe('Target instance id (from mesh_peers)'),
      message: z.string().min(1),
      wait_seconds: z.number().int().min(1).max(300).optional().describe('Default 60'),
    }),
    callback: async ({ peer_id, message, wait_seconds }) => {
      const results = await mesh.send(peer_id, message, (wait_seconds || 60) * 1000)
      if (!results.length) return `No response from ${peer_id} (timeout)`
      return results.map((r) => r.result).join('\n')
    },
  })

  return [meshPeers, meshBroadcast, meshSend]
}
