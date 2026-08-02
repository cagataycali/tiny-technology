/**
 * The voice agent's tool roster — the SAME tools the chat agent mounts for
 * this session type (docs/voice-sessions-design.md, inline-chat iteration),
 * converted to the realtime API's function-tool shape. Execution happens on
 * the client over the VoiceSession DO's tool_call/tool_result WS bridge,
 * with the executors chat already ships — these schemas only tell the model
 * what it can call. Mounting mirrors the chat route: render_ui's contract
 * inverts for native (props-only, no code), and the round-trip media tools
 * (screenshot / generate_image) are native-only, exactly like chat.
 */
import {
  renderUiTool,
  renderUiNativeTool,
  rememberTool,
  forgetTool,
  vibrateTool,
  flashlightTool,
  copyToClipboardTool,
  setBrightnessTool,
  playSoundTool,
  scheduleAlertTool,
  cancelAlertsTool,
  openUrlTool,
} from '@/lib/chat/tools/client-side'
import { makeLearnTool, makeRecallTool, makeUnlearnTool } from '@/lib/chat/tools/memory'
import { makeSendMessageTool, makeReadMessagesTool } from '@/lib/chat/tools/messages'
import { makeNiclaTakePhotoTool, makeNiclaTakeVideoTool, makeNiclaListenTool, makeNiclaStatusTool } from '@/lib/chat/tools/nicla'
import { makeNiclaVoiceStatusTool, makeNiclaVoiceWakesTool, makeNiclaVoiceRecordTool, makeNiclaVoiceTranscriptsTool, makeNiclaVoiceTranscriptTool } from '@/lib/chat/tools/nicla-voice'
import { makeFlipperStatusTool, makeFlipperListenTool, makeFlipperFilesTool } from '@/lib/chat/tools/flipper'

export type RealtimeTool = {
  type: 'function'
  name: string
  description: string
  parameters: any
}

/** Strands tool → realtime function tool (toolSpec.inputSchema is already
 *  plain JSON Schema — no zod at the call site). */
const fromStrands = (t: any): RealtimeTool => ({
  type: 'function',
  name: String(t.toolSpec.name),
  description: String(t.toolSpec.description || '').slice(0, 1024),
  parameters: t.toolSpec.inputSchema,
})

/** sessionType is the x-tiny-session header: 'tiny-ios' | 'tiny-android' |
 *  anything else = web browser. */
export function buildVoiceTools(sessionType: string): RealtimeTool[] {
  const native = sessionType === 'tiny-ios' || sessionType === 'tiny-android'
  const roster: RealtimeTool[] = [
    native ? renderUiNativeTool : renderUiTool,
    rememberTool,
    forgetTool,
    vibrateTool,
    flashlightTool,
    copyToClipboardTool,
    setBrightnessTool,
    playSoundTool,
    scheduleAlertTool,
    cancelAlertsTool,
    openUrlTool,
    // Server tools (worker-backed account memory + DMs) — the client forwards
    // these to POST /api/voice/tool, which runs the same session-bound tool
    // objects chat mounts. Factories called with null here: only the schema
    // is read. ("send a message to mert" mid-call was the user ask.)
    makeLearnTool(null),
    makeRecallTool(null),
    makeUnlearnTool(null),
    makeSendMessageTool(null),
    makeReadMessagesTool(null),
    // 💎 The necklace (Nicla Vision) — server round-trip via the relay, so
    // voice is a natural surface ("what's in front of me?" spoken aloud).
    // Factories with null: only schemas are read; /api/voice/tool executes.
    makeNiclaTakePhotoTool(null),
    makeNiclaTakeVideoTool(null),
    makeNiclaListenTool(null),
    makeNiclaStatusTool(null),
    // 🎙️ The voice necklace — the board is read-only (no WiFi, no camera, no
    // relay), so the spoken question it answers is "did my necklace hear
    // anything?". The recorder commands the paired PHONE's mic instead, and the
    // transcript tools read what it stored. Same null-factory rule: schemas
    // only; /api/voice/tool executes.
    makeNiclaVoiceStatusTool(null),
    makeNiclaVoiceWakesTool(null),
    makeNiclaVoiceRecordTool(null),
    makeNiclaVoiceTranscriptsTool(null),
    makeNiclaVoiceTranscriptTool(null),
    makeFlipperStatusTool(null),
    makeFlipperListenTool(null),
    makeFlipperFilesTool(null),
  ].map(fromStrands)
  if (native) {
    // Round-trip media tools: the device executes (consent-gated capture /
    // on-device generation), uploads via /api/media, and replies tool_result
    // with the hosted URL. Declared inline — chat's factories bind
    // server-poll callbacks the voice bridge doesn't use.
    roster.push({
      type: 'function',
      name: 'screenshot',
      description:
        'Capture what is currently on the user device screen (the user is asked for consent each time) and receive it as a hosted image URL. Use when the user references what they are looking at.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why you need to see the screen — shown in the consent prompt',
          },
        },
        additionalProperties: false,
      },
    })
    // 🕶️ Glasses photo — voice is the NATURAL surface for this tool
    // ("what am I looking at?" is a spoken question). BOTH native surfaces
    // execute these locally in their voice tool bridges (iOS ChatModel
    // voiceMetaTakePhoto; Android MainActivity runVoiceTool) — the device
    // answers fast and honestly when no glasses are linked/worn, so
    // advertising them unconditionally on a native surface never strands
    // the model.
    {
      roster.push({
        type: 'function',
        name: 'meta_take_photo',
        description:
          "Take a photo through the user's Meta AI glasses camera — what the user is physically LOOKING AT right now. Use when they ask about their surroundings, what they see, to read or identify something in front of them, or to capture the moment. Needs their glasses linked and worn; you receive the hosted image URL and the photo lands in the chat. Tell the user out loud what you see or that it's captured.",
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Optional short reason for the capture' },
          },
          additionalProperties: false,
        },
      })
      // 🎥 Toggle recording works mid-call too — "start/stop recording".
      roster.push({
        type: 'function',
        name: 'meta_record_video',
        description:
          "Record a video through the user's Meta AI glasses. TOGGLE: call once to start (tell the user it's rolling — the LED is on), call again to stop; on stop you receive the hosted clip URL and it lands in the chat. Auto-stops around 30 seconds. Needs linked, worn glasses.",
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Optional short reason' },
          },
          additionalProperties: false,
        },
      })
      // 🕶️ Status is instant and safe mid-call. meta_listen is deliberately
      // ABSENT here: on a live call the model already hears the user through
      // the glasses mic — a second tap on the same input would fight the call.
      roster.push({
        type: 'function',
        name: 'meta_glasses_status',
        description:
          "Check the user's Meta AI glasses right now: linked, connected/ready for capture, device names, thermal, whether a recording is running. Instant.",
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      })
    }
    // On-device generation is iOS-only (ImageCreator / Apple Intelligence);
    // Android chat runs generate_image server-side, which the voice bridge
    // doesn't reach yet — don't advertise a tool the device can't answer.
    if (sessionType === 'tiny-ios') {
      roster.push({
        type: 'function',
        name: 'generate_image',
        description:
          'Generate an image from a text prompt on the user device; the result renders as a card in the chat and you receive its hosted URL. Tell the user out loud when it is ready.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What to draw' },
            style: { type: 'string', description: 'Optional style hint' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      })
    }
  }
  return roster
}
