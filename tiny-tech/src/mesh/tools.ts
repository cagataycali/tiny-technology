/**
 * mesh_* tools — the local agent's window into the zenoh mesh.
 * Direct port of devduck's zenoh_peer tool surface: peers/broadcast/send.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { MeshNode } from './zenoh.js'

/**
 * @param hop How many mesh legs the turn holding these tools already travelled
 *   (0 = a local human asked). Every dispatch stamps hop+1 on the wire, so a
 *   responder can refuse to relay further instead of amplifying a broadcast.
 */
export function makeMeshTools(mesh: MeshNode, hop = 0) {
  const meshPeers = tool({
    name: 'mesh_peers',
    description: 'List agents auto-discovered on the zenoh mesh (devduck instances + tiny-tech nodes on this LAN / connected endpoints) — instance id, host, model, platform, cwd, tool count, freshness. Includes nodes other tiny processes on this machine discovered (file registry), and shows each peer\'s advertised tools so you can pick the right one.',
    inputSchema: z.object({
      verbose: z.boolean().optional().describe('Include each peer\'s full tool list + identity summary'),
    }),
    callback: async ({ verbose }) => {
      const peers = mesh.listAllPeers()
      if (!peers.length) {
        return `No peers discovered yet (mesh id: ${mesh.instanceId})\n`
          + '💡 Start tiny on another machine (`npx tiny-tech`) or a devduck with zenoh — discovery is automatic via multicast (224.0.0.224:7446). Off-LAN peers need ZENOH_CONNECT/ZENOH_LISTEN.'
      }
      const now = Date.now()
      return JSON.stringify({
        my_instance_id: mesh.instanceId,
        peer_count: peers.length,
        peers: peers.map((p) => ({
          id: p.instanceId,
          hostname: p.hostname,
          model: p.model,
          platform: p.platform,
          cwd: p.cwd,
          tool_count: p.toolCount,
          up_since: p.started,
          seen_seconds_ago: Math.round((now - p.lastSeen) / 1000),
          via: p.source || 'zenoh',
          ...(verbose ? { tools: p.tools, identity: p.systemPrompt } : {}),
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
      const results = await mesh.broadcast(message, (wait_seconds || 60) * 1000, undefined, hop)
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
      const results = await mesh.send(peer_id, message, (wait_seconds || 60) * 1000, undefined, hop)
      if (!results.length) return `No response from ${peer_id} (timeout)`
      // Always name the responder. Returning the bare text made a reply from
      // the wrong node indistinguishable from the right one — and an agent
      // that misreports its own id then looks like a loopback.
      return results.map((r) => {
        const tag = r.responder === peer_id ? r.responder : `${r.responder} ⚠️ (asked ${peer_id})`
        return `── ${tag} ──\n${r.result}`
      }).join('\n\n')
    },
  })

  return [meshPeers, meshBroadcast, meshSend]
}
