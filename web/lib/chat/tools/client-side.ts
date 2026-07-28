/**
 * Client-executed tools (extracted from the chat route) — server callbacks
 * are no-ops; the browser watches beforeToolCallEvent and performs the
 * real action (rendering, localStorage writes, conversation surgery).
 * All stateless — plain exports, no factories.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const renderUiTool = tool({
  name: 'render_ui',
  description: 'Render 100% dynamic React components on the client side. Send complete React component code using React.createElement (NOT JSX). Available libraries: React, recharts (LineChart, BarChart, PieChart, AreaChart, etc.). Use createElement or the alias "h" for creating elements.',
  inputSchema: z.object({
    componentCode: z.string().describe('Complete React component code as a string using React.createElement syntax. Use arrow function: (props) => { return createElement(...) }. Available: React.useState, createElement (aliased as h), recharts components via props.recharts. DO NOT use JSX syntax (<div>) - use createElement("div") instead.'),
    props: z.record(z.any(), z.any()).optional().describe('Props to pass to the component (optional, any JSON object)'),
    title: z.string().optional().describe('Optional title for the UI component'),
  }),
  callback: async (_input: any) => {
    // No-op: rendering happens client-side
    return { ok: true, note: 'Dynamic UI will be rendered on client' }
  },
})

// Native apps (iOS/Android) never execute componentCode — they render
// charts/tables/lists natively from `props`. A componentCode-only call
// degrades to a "view on web" card there, so for native sessions the
// tool contract inverts: props is REQUIRED and carries the data.
export const renderUiNativeTool = tool({
  name: 'render_ui',
  description: 'Render a native UI card (charts, tables, key-value grids, lists) from structured data. Put ALL displayable data in `props` — this client renders props natively and NEVER executes code. Chart: props.data = [{label, value}] rows (≤3 numeric series). Table: props.columns + props.rows. List: props.items = [{title, subtitle}]. Markdown: props.markdown.',
  inputSchema: z.object({
    props: z.record(z.any(), z.any()).describe('REQUIRED structured data to render: {title, data:[{label,value}]} for charts, {columns,rows} for tables, {items:[{title,subtitle}]} for lists, {markdown} for rich text. The card is drawn from these fields alone.'),
    title: z.string().optional().describe('Optional title for the UI card'),
    componentCode: z.string().optional().describe('Ignored on this client (native rendering) — omit it.'),
  }),
  callback: async (_input: any) => {
    // No-op: rendering happens client-side
    return { ok: true, note: 'Rendered natively on the device from props' }
  },
})

export const speakTool = tool({
  name: 'speak',
  description: `Speak text aloud to the user with on-device neural TTS (a playback card with the transcript renders in the chat). Use it whenever the user is in voice mode (🎙️ system note present) — they are listening, not reading — and whenever they ask to hear something. Pass plain conversational prose (no markdown, no code). Keep each call under ~600 characters; call again for more.`,
  inputSchema: z.object({
    text: z.string().describe('What to say, as plain spoken prose (no markdown/code/URLs)'),
    voice: z.string().optional().describe("Voice id (default af_heart). Others: am_michael, am_puck (US male), af_bella, af_sky (US female), bf_emma (UK female), bm_george (UK male)"),
  }),
  callback: async () => ({ ok: true, note: 'Spoken on the client — a playback card was rendered.' }),
})

export const suggestFollowupsTool = tool({
  name: 'suggest_followups',
  description: 'Suggest 2-4 short follow-up prompts shown as clickable chips under your response. Call this at the END of your response when you know the best next moves for the user. Keep each chip under 8 words.',
  inputSchema: z.object({
    chips: z.array(z.string()).min(1).max(4).describe('Short follow-up prompts (max 4, each < 8 words)'),
  }),
  callback: async () => ({ ok: true, note: 'Chips rendered client-side' }),
})

export const rememberTool = tool({
  name: 'remember',
  description: 'Store a durable memory about the user or conversation that persists across history clears and sessions (stored in the user browser). Use for preferences, facts, ongoing projects, names. Keep it short and factual.',
  inputSchema: z.object({
    content: z.string().describe('The memory to store (short, factual, < 200 chars ideal)'),
    tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
  }),
  callback: async () => ({ ok: true, note: 'Memory stored client-side' }),
})

export const forgetTool = tool({
  name: 'forget',
  description: 'Delete a stored memory by its text content (substring match). Use when the user asks you to forget something.',
  inputSchema: z.object({
    match: z.string().describe('Text to match against stored memories'),
  }),
  callback: async () => ({ ok: true, note: 'Memory removed client-side' }),
})

// ✂️ Conversation surgery (issue #9, careless manage_messages) — executed
// CLIENT-side (history lives in the browser); this is the schema + no-op
// callback pattern used by remember/forget/render_ui.
export const manageMessagesTool = tool({
  name: 'manage_messages',
  description: `Manage the conversation history stored in the user's browser. Actions: stats (message/char counts), drop (remove messages by 1-based position range, e.g. the oldest 10), compact (replace a range with a one-line summary you provide). Use when the user asks to clean up, or when the conversation feels bloated with stale context. The visible chat updates immediately.`,
  inputSchema: z.object({
    action: z.enum(['stats', 'drop', 'compact']),
    from: z.number().optional().describe('Range start, 1-based message position (drop/compact)'),
    to: z.number().optional().describe('Range end, inclusive (drop/compact)'),
    summary: z.string().optional().describe('Replacement summary text (compact only)'),
  }),
  callback: async (input) => ({
    ok: true,
    note: `Executed client-side: ${input.action}${input.from ? ` ${input.from}-${input.to ?? input.from}` : ''}`,
  }),
})

export const vibrateTool = tool({
  name: 'vibrate',
  description:
    'Physically vibrate the user\'s device with a haptic pattern. Native apps play real motion patterns; some browsers ignore it. Use for attention, alarms, timers ending, celebrations, or whenever the user asks to FEEL something. Repeating is fine — "vibrate a lot" is a valid request.',
  inputSchema: z.object({
    pattern: z
      .enum(['tap', 'double', 'success', 'warning', 'error', 'heartbeat', 'sos', 'long', 'escalate', 'wave'])
      .optional()
      .describe('Haptic pattern (default tap). heartbeat/sos/wave are multi-beat motions, long is a sustained buzz, escalate ramps up, wave swells up and down.'),
    times: z.number().int().min(1).max(20).optional().describe('Repeat the whole pattern N times (default 1, max 20)'),
    intensity: z.number().min(0.1).max(1).optional().describe('Strength 0.1-1 (default 1)'),
  }),
  callback: async () => ({ ok: true, note: 'Vibration played on the user device' }),
})

export const flashlightTool = tool({
  name: 'flashlight',
  description:
    'Control the device flashlight/torch (native apps only; browsers ignore it). Steady on (auto-off), off, or blink N times. Use for find-my-phone moments, attention, or signaling.',
  inputSchema: z.object({
    mode: z.enum(['on', 'off', 'blink']).describe('on = steady (auto-off after `seconds`), off = stop, blink = flash on/off'),
    times: z.number().int().min(1).max(30).optional().describe('Blink count (default 5, blink mode only)'),
    seconds: z.number().min(1).max(60).optional().describe('Auto-off delay for mode "on" (default 10, max 60)'),
  }),
  callback: async () => ({ ok: true, note: 'Flashlight controlled on the user device' }),
})

export const copyToClipboardTool = tool({
  name: 'copy_to_clipboard',
  description:
    "Copy text to the user's device clipboard (native apps; browsers may ignore). Use when the user asks to copy something — an address, code, link, phone number — so they can paste it elsewhere.",
  inputSchema: z.object({
    text: z.string().max(10_000).describe('Exactly what to place on the clipboard (no commentary)'),
  }),
  callback: async () => ({ ok: true, note: 'Copied on the user device' }),
})

export const setBrightnessTool = tool({
  name: 'set_brightness',
  description:
    "Set the device screen brightness (native apps only). Use when asked to dim/brighten the screen — reading at night, saving battery, showing a QR code.",
  inputSchema: z.object({
    level: z.number().min(0).max(1).describe('0 = darkest, 1 = full brightness'),
  }),
  callback: async () => ({ ok: true, note: 'Brightness set on the user device' }),
})

export const playSoundTool = tool({
  name: 'play_sound',
  description:
    'Play an attention sound on the device (native apps only). Pairs well with vibrate for alarms and timers.',
  inputSchema: z.object({
    sound: z.enum(['alert', 'alarm', 'chime', 'tick']).optional().describe('Sound character (default alert)'),
    seconds: z.number().min(1).max(30).optional().describe('Keep repeating for N seconds (default: play once)'),
  }),
  callback: async () => ({ ok: true, note: 'Sound played on the user device' }),
})

export const scheduleAlertTool = tool({
  name: 'schedule_alert',
  description:
    'Schedule a LOCAL alarm/reminder notification on the device — it fires with sound + vibration even if the app is closed or the phone is locked (native apps only). Use for "remind me in 20 minutes", timers, wake-ups. For recurring/server-side jobs use the schedule tool instead.',
  inputSchema: z.object({
    title: z.string().max(80).describe('Notification title, e.g. "⏰ Tea is ready"'),
    body: z.string().max(200).optional().describe('Optional detail line'),
    in_minutes: z.number().min(0.2).max(1440).describe('Fire after N minutes from now (max 24h)'),
  }),
  callback: async () => ({ ok: true, note: 'Local alarm scheduled on the user device' }),
})

export const openUrlTool = tool({
  name: 'open_url',
  description:
    'Open a URL on the device — websites, or app deep links like maps/spotify (native apps only). Use when the user asks to open, navigate, or show something that lives in another app or the browser.',
  inputSchema: z.object({
    url: z.string().max(2000).describe('https:// URL or a well-known app scheme (maps:, spotify:, music:, shortcuts:)'),
  }),
  callback: async () => ({ ok: true, note: 'Opened on the user device' }),
})

export const cancelAlertsTool = tool({
  name: 'cancel_alerts',
  description:
    'Cancel pending local alarms/reminders previously set with schedule_alert on this device (native apps only). Use when the user says to cancel, stop, or clear an alarm or reminder.',
  inputSchema: z.object({
    confirm: z.literal(true).describe('Must be true — cancels ALL pending agent-set alerts on the device'),
  }),
  callback: async () => ({ ok: true, note: 'Pending agent alerts cancelled on the user device' }),
})

// 🗺️ Agent map controls (agi-diy index.html:2607-2835 port; maps-location
// loop c10) — act on the live map behind the chat (the 📍 toggle / /map
// page). Fire-and-forget like speak/vibrate: the browser's map bridge
// executes on beforeToolCallEvent; with no map mounted the client shows a
// "tap 📍" hint instead, so the notes below stay honest either way.

export const addMapMarkerTool = tool({
  name: 'add_map_marker',
  description:
    "Drop a labeled pin on the user's live map (visible when their 📍 location toggle or /map page is open). Use it to SHOW places you're talking about — a café you recommend, a meeting point, each stop of a route.",
  inputSchema: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude of the pin'),
    lng: z.number().min(-180).max(180).describe('Longitude of the pin'),
    label: z.string().max(40).optional().describe('Short label shown under the pin'),
    color: z.string().optional().describe("CSS color for the pin (default: the tiny's accent)"),
    id: z
      .string()
      .max(32)
      .optional()
      .describe('Stable id YOU choose (e.g. "stop-1") so you can remove_map_marker / fly_to_marker / tour_markers it later. Re-using an id moves that pin.'),
  }),
  callback: async () => ({
    ok: true,
    note: 'Pin placed on the live map (if the map is off, the user was hinted to tap 📍).',
  }),
})

export const removeMapMarkerTool = tool({
  name: 'remove_map_marker',
  description:
    'Remove ONE pin you previously placed on the live map, by the id you gave add_map_marker (or its label). For wiping everything use clear_map_markers.',
  inputSchema: z.object({
    id: z.string().max(40).describe("The id you passed to add_map_marker, or the pin's label"),
  }),
  callback: async () => ({ ok: true, note: 'Pin removed from the live map (no-op if the id was unknown).' }),
})

export const flyToMarkerTool = tool({
  name: 'fly_to_marker',
  description:
    'Glide the live map camera to a pin you previously placed, by the id you gave add_map_marker (or its label). Great for walking the user through places one at a time.',
  inputSchema: z.object({
    id: z.string().max(40).describe("The id you passed to add_map_marker, or the pin's label"),
    zoom: z.number().min(1).max(20).optional().describe('Zoom level (15 ≈ streets, 10 ≈ city, 4 ≈ country)'),
  }),
  callback: async () => ({
    ok: true,
    note: 'Map camera moved to the pin (no-op if the id was unknown or the map is off).',
  }),
})

export const tourMarkersTool = tool({
  name: 'tour_markers',
  description:
    'Tour the live map through pins you placed, in order — the camera glides to each and pauses. Perfect for presenting a route or itinerary: drop pins with ids first, then tour them.',
  inputSchema: z.object({
    ids: z
      .array(z.string().max(40))
      .min(2)
      .max(12)
      .describe('Pin ids or labels (from add_map_marker) to visit, in order'),
    pause_ms: z
      .number()
      .min(500)
      .max(10_000)
      .optional()
      .describe('Pause at each stop in milliseconds (default 2000)'),
  }),
  callback: async () => ({
    ok: true,
    note: 'Tour started on the live map — the camera is visiting each pin (unknown ids are skipped).',
  }),
})

export const flyToLocationTool = tool({
  name: 'fly_to_location',
  description:
    "Glide the user's live map camera to a place (visible when their 📍 toggle or /map page is open). Pair with add_map_marker: drop the pin, then fly to it.",
  inputSchema: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude to center on'),
    lng: z.number().min(-180).max(180).describe('Longitude to center on'),
    zoom: z.number().min(1).max(20).optional().describe('Zoom level (15 ≈ streets, 10 ≈ city, 4 ≈ country)'),
  }),
  callback: async () => ({
    ok: true,
    note: 'Map camera moved (if the map is off, the user was hinted to tap 📍).',
  }),
})

export const clearMapMarkersTool = tool({
  name: 'clear_map_markers',
  description: "Remove every pin you previously placed on the user's live map.",
  inputSchema: z.object({
    confirm: z.literal(true).describe('Must be true — clears ALL agent-placed pins'),
  }),
  callback: async () => ({ ok: true, note: 'Agent-placed pins cleared from the live map.' }),
})
