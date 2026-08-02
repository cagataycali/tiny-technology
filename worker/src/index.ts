import { OpenAPIRouter } from "@cloudflare/itty-router-openapi";

/**
 * tiny.technology
 * 
 * plugin.tiny.technology/get -> Return AI
 * plugin.tiny.technology/upsert -> Create or update tiny ai identity.
*/
import { UpsertCall } from "./upsert";
import { GetCall } from "./get";
import { RetrieveCall } from "./retrieve";
import { TurnStoreCall } from "./turns";
import { LegalCall } from "./legal";
import { ListCall } from "./list";
import { UserUpsertCall, UserGetCall, CredentialAddCall, CredentialListCall, CredentialSignCountCall } from "./users";
import { CommunityCall } from "./community";
import { ProfileCall } from "./profile";
import { ReputationGetCall } from "./reputation";
import { ShareCreateCall, ShareGetCall, ShareDeleteCall, ShareListCall } from "./share";
import { TinyDeleteCall } from "./delete";
import { LearningsListCall, LearningsAddCall, LearningsDeleteCall, GraphNeighborsCall, GraphAllCall, GraphConflictsCall, GraphResolveCall, SocialRecordCall, SocialGraphCall, FollowCall, FeedCall } from "./learnings";
import { EventsEmitCall, EventsListCall } from "./events";
import { sweepToolUpdates } from "./tool-updates";
import { sweepReconcileAlarm } from "./reconcile-alarm";
import { sweepMissedTasks } from "./relay-missed";
import { ArchiveCreateCall, ArchiveGetCall, ArchiveListCall, ArchiveDeleteCall } from "./archives";
import { JobsCreateCall, JobsListCall, JobsDeleteCall, runDueJobs } from "./scheduler";
import { PushKeyCall, PushSubscribeCall, PushUnsubscribeCall, PushSendCall, sendPushToUser } from "./push";
import { ToolsListCall, ToolsUpsertCall, ToolsDeleteCall, ToolsBrowseCall } from "./tools";
import { TelegramConfigCall, TelegramGetCall, TelegramDeleteCall, pollTelegramBots } from "./telegram";
import { TelegramApiCall } from "./telegram-api";
import { PrefsGetCall, PrefsSetCall } from "./prefs";
import { ModelConfigGetCall, ModelConfigSetCall } from "./model-config";
import { AccountVoiceGetCall, AccountVoiceSetCall } from "./account-voice";
import { DeviceEnrollCall, DeviceHeartbeatCall, DevicesListCall, DeviceRevokeCall, DeviceRotateTokenCall, DeviceEndpointCallRoute, DeviceEventCall } from "./devices";
import { TranscriptAddCall, TranscriptListCall, TranscriptGetCall } from "./transcripts";
import { LocationBeatCall, LocationsListCall, LocationDeleteCall, LOCATION_SWEEP_SQL, LOCATION_SWEEP_AGE_S } from "./locations";
import { PayBalanceCall, PayInvokeCall, PayTransferCall, PayRefundCall, PayPriceSetCall, PayPricingCall, PayCreditCall, PaySpendCall, PaySpendReverseCall, PaySpendSentCall, PaySettleUnknownCall, PayReconcileStatusCall, reconcileSentSpends, reconcileSettleUnknown } from "./payments";
import { PayLinkAddressCall, PayClaimCall, PayDepositInfoCall, PayFaucetCall } from "./deposits";
import { WithdrawRequestCall, WithdrawCompleteCall, WithdrawFailCall } from "./withdrawals";
import { RelaySendCall, RelayPollCall, RelayReplyCall, RelayRecvCall, RelayDepositCall, RelayTaskResultCall } from "./relay";
import { RingGetCall, RingAddCall } from "./ring";
import { VisitCall } from "./visit";
import { MessageSendCall, MessagesListCall, MessagesUnreadCall, MessageDeleteCall } from "./messages";
import { MediaUploadCall, MediaGetCall, ToolResultPostCall, ToolResultGetCall } from "./media";
import { VoiceSession, voiceSessionCreate, voiceConnect, voiceReap, voiceRecording, voiceReplayAsset, VoiceSessionsListCall, VoiceSessionGetCall } from "./voice";

export const router = OpenAPIRouter({
  schema: {
    info: {
      title: 'Tiny | We are a software, not a company.',
      description: 'Tiny is a service designed to enable everyone to create their own AI-powered applications. We are a software, together. I know who you are, you know who I am. We are a software, not a company.',
      version: 'v0.0.1',
    },
  },
  docs_url: '/',
  aiPlugin: {
    name_for_human: 'tiny',
    name_for_model: 'tiny',
    description_for_human: "Tiny AI offers a platform for everyone to create and manage AI services with ease.",
    description_for_model: "Tiny AI facilitates the creation and management of AI services for everyone.",
    contact_email: 'help@tinyai.id',
    legal_info_url: 'https://plugin.tiny.technology/legal',
    logo_url: 'https://tiny.technology/tiny.png',
  },
})

router.post('/upsert', UpsertCall)
router.delete('/tiny', TinyDeleteCall)
router.get('/get', GetCall)
router.get('/retrieve', RetrieveCall)
router.post('/turns', TurnStoreCall)
router.get('/list', ListCall)
router.get('/legal', LegalCall)
router.get('/community', CommunityCall)
router.get('/profile', ProfileCall)
router.post('/share', ShareCreateCall)
router.get('/share', ShareGetCall)
router.delete('/share', ShareDeleteCall)
router.get('/share/list', ShareListCall)
router.post('/archive', ArchiveCreateCall)
router.get('/archive/list', ArchiveListCall)
router.get('/archive', ArchiveGetCall)
router.delete('/archive', ArchiveDeleteCall)
router.get('/learnings', LearningsListCall)
router.post('/learnings', LearningsAddCall)
router.delete('/learnings', LearningsDeleteCall)
router.get('/graph/neighbors', GraphNeighborsCall)
router.get('/graph/all', GraphAllCall)
router.get('/graph/conflicts', GraphConflictsCall)
router.post('/graph/resolve', GraphResolveCall)
router.post('/graph/social', SocialRecordCall)
router.get('/graph/social', SocialGraphCall)
router.post('/follow', FollowCall)
router.get('/graph/feed', FeedCall)
// 🏅 Reputation the network granted a builder (points, own table — never the
// money ledger). Internal-key only: it gates rate limits, so a public read
// would let anyone enumerate who has slack.
router.get('/reputation', ReputationGetCall)
router.post('/events', EventsEmitCall)
router.get('/events', EventsListCall)
router.post('/jobs', JobsCreateCall)
router.get('/jobs', JobsListCall)
router.delete('/jobs', JobsDeleteCall)
router.get('/push/key', PushKeyCall)
router.post('/push/subscribe', PushSubscribeCall)
router.delete('/push/subscribe', PushUnsubscribeCall)
router.post('/push/send', PushSendCall)
router.get('/tools/browse', ToolsBrowseCall)
router.get('/tools', ToolsListCall)
router.post('/tools', ToolsUpsertCall)
router.delete('/tools', ToolsDeleteCall)
router.post('/telegram/api', TelegramApiCall)
router.post('/telegram', TelegramConfigCall)
router.get('/telegram', TelegramGetCall)
router.delete('/telegram', TelegramDeleteCall)
router.get('/prefs', PrefsGetCall)
router.post('/prefs', PrefsSetCall)
// 🧠 Synced BYO-model config (cross-device) — internal-key only; api key
// encrypted at rest, only the server-side chat route reads it non-safe.
router.get('/model-config', ModelConfigGetCall)
router.post('/model-config', ModelConfigSetCall)
// 🎙️ Account-default live-call voice — internal-key only. Fallback for tinys
// with no per-tiny voice set (per-tiny voice → account voice → 'marin').
router.get('/account-voice', AccountVoiceGetCall)
router.post('/account-voice', AccountVoiceSetCall)
// 🖥️ Device registry (tiny-node PR2) — internal-key only, app proxies front it
router.post('/device/enroll', DeviceEnrollCall)
router.post('/device/heartbeat', DeviceHeartbeatCall)
router.get('/device/list', DevicesListCall)
router.delete('/device', DeviceRevokeCall)
// Re-key a device the caller already owns, so a second client can adopt it
// without re-enrolling the hardware (which would mint a new row and orphan the
// old one). POST because it mutates: the previous token stops working at once.
router.post('/device/rotate-token', DeviceRotateTokenCall)
// 🎙️ Devices that notice things on their own (Nicla Voice wake word) push onto
// the owner's event ring — the one path in the device model that isn't pull.
router.post('/device/event', DeviceEventCall)
// 🤖 Endpoint devices dial OUT: the worker holds the bearer and makes the call,
// so the credential never reaches the edge app (docs/endpoint-devices-vision).
router.post('/device/endpoint/call', DeviceEndpointCallRoute)
// 🎤 Nicla Voice recorder (migration 0030): after a wake (or a nicla_voice_record
// envelope) the paired phone records + transcribes on-device and stores the text
// here. The write authenticates like /device/event (token resolves the owner);
// the reads are userId-stamped by the app proxy / agent tools.
router.post('/transcript', TranscriptAddCall)
router.get('/transcript/list', TranscriptListCall)
router.get('/transcript', TranscriptGetCall)
// 🗺️ Map presence — heartbeat IS the opt-in, delete is the opt-out; the
// staleness window (locations.ts) hides dead clients on its own
router.post('/location/heartbeat', LocationBeatCall)
router.get('/location/list', LocationsListCall)
router.delete('/location', LocationDeleteCall)
router.post('/device/relay/send', RelaySendCall)
router.post('/device/relay/poll', RelayPollCall)
router.post('/device/relay/reply', RelayReplyCall)
router.get('/device/relay/recv', RelayRecvCall)
// 🤖 spawn_agents wait:false parks its finished batch here under a batch_*
// ticket — redeemed by the SAME recv, announced by the same push pattern.
router.post('/device/relay/deposit', RelayDepositCall)
// 💻 A daemon's use_tasks completion (device-token auth): deposit + ring
// event + push — closes the "Task started…" in-window reply gap.
router.post('/device/task-result', RelayTaskResultCall)
// 💸 Payments (PR1 ledger-core) — internal-key except public pricing read
router.get('/pay/balance', PayBalanceCall)
router.post('/pay/invoke', PayInvokeCall)
router.post('/pay/transfer', PayTransferCall)
router.post('/pay/refund', PayRefundCall)
router.post('/pay/price', PayPriceSetCall)
router.get('/pay/pricing', PayPricingCall)
router.post('/pay/credit', PayCreditCall)
router.post('/pay/spend', PaySpendCall)
router.post('/pay/spend-sent', PaySpendSentCall)
router.post('/pay/spend-reverse', PaySpendReverseCall)
// 🔍 The RECEIVER's unknown: our x402 door took a payment whose settlement was
// submitted but never confirmed, so it 402'd and credited nobody. If the tx
// lands, the owner is owed money nothing else records (migration 0028).
router.post('/pay/settle-unknown', PaySettleUnknownCall)
// 🩺 The READER both reconciliation queues never had. 0027 and 0028 each paid a
// design cost to keep queue depth meaningful ("the depth is the alarm") and
// nothing ever looked. Reports depth, backlog age, resolution histograms, and —
// the number that actually matters — how many rows the NEXT sweep will skip,
// since a few permanently-stuck rows at the head starve every row behind them.
router.get('/pay/reconcile-status', PayReconcileStatusCall)
router.post('/pay/link-address', PayLinkAddressCall)
router.post('/pay/claim', PayClaimCall)
router.get('/pay/deposit-info', PayDepositInfoCall)
router.post('/pay/faucet', PayFaucetCall)
router.post('/pay/withdraw-request', WithdrawRequestCall)
router.post('/pay/withdraw-complete', WithdrawCompleteCall)
router.post('/pay/withdraw-fail', WithdrawFailCall)
router.get('/ring', RingGetCall)
router.post('/ring', RingAddCall)
router.post('/visit', VisitCall)
// 🖼️ Device-generated media + client-tool result mailbox (on-device genAI
// tools) — upload/result are internal-key (app proxies stamp the userId);
// /media/:key is public-but-unguessable so every client renders by URL.
router.post('/media/upload', MediaUploadCall)
router.get('/media/:key', MediaGetCall)
router.post('/device/tool-result', ToolResultPostCall)
router.get('/device/tool-result', ToolResultGetCall)
// 🎙️ Voice sessions (real speech-to-speech, docs/voice-sessions-design.md) —
// /voice/session mints a VoiceSession DO (internal-key; app supplies the BYO
// OpenAI key); /voice/connect/:id is the client WS upgrade (auth = unguessable
// id + single-use ticket). Plain handlers: WS upgrade + internal-only.
router.post('/voice/session', (req: Request, env: any) => voiceSessionCreate(req, env))
router.get('/voice/connect/:id', (req: Request, env: any) => voiceConnect(req, env))
router.post('/voice/reap/:id', (req: Request, env: any) => voiceReap(req, env))
router.get('/voice/recording/:id', (req: Request, env: any) => voiceRecording(req, env))
router.get('/voice/sessions', VoiceSessionsListCall)
router.get('/voice/session', VoiceSessionGetCall)
router.get('/voice/replay/:id/:file', (req: Request, env: any) => voiceReplayAsset(req, env))
router.post('/message', MessageSendCall)
router.get('/messages', MessagesListCall)
router.get('/message/unread', MessagesUnreadCall)
router.delete('/message', MessageDeleteCall)

// User / WebAuthn / ownership (internal — guarded by X-Internal-Key)
router.post('/user/upsert', UserUpsertCall)
router.get('/user/get', UserGetCall)
router.post('/credential/add', CredentialAddCall)
router.get('/credential/list', CredentialListCall)
router.post('/credential/signcount', CredentialSignCountCall)

// 404 for everything else
router.all('*', () => new Response('Not Found.', { status: 404 }))

// Durable Object binding (wrangler.toml [[durable_objects.bindings]]) — the
// voice-session relay+recorder. Must be a named export from the entrypoint.
export { VoiceSession };

export default {
  // Wrap router.handle so an UNCAUGHT throw in any route handler becomes a
  // clean JSON 500 instead of Cloudflare's generic "Worker threw an exception"
  // page (which is ugly and can surface internal detail). Most handlers guard
  // their own bodies, but a stray top-level DB/KV error would otherwise escape.
  async fetch(request: Request, env: any, ctx: any) {
    try {
      return await router.handle(request, env, ctx);
    } catch (err: any) {
      console.log(err, 'unhandled route error', new URL(request.url).pathname);
      return new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
  // ⏰ Cron Trigger (wrangler.toml [triggers]) — fires due scheduled jobs
  async scheduled(_event: any, env: any, ctx: any) {
    ctx.waitUntil(runDueJobs(env));
    ctx.waitUntil(pollTelegramBots(env));
    // Weekly (self-gated via KV stamp): notify owners of outdated pinned tools
    ctx.waitUntil(sweepToolUpdates(env));
    // 🗺️ Map-presence hygiene: day-old rows are invisible already (5-min
    // window) — this keeps last-known coordinates of clients that died
    // without their opt-out DELETE from resting in the table. Swallow
    // errors until migration 0023 lands everywhere: a missing table must
    // not poison the other cron work.
    ctx.waitUntil(
      env.DB.prepare(LOCATION_SWEEP_SQL)
        .bind(Math.floor(Date.now() / 1000) - LOCATION_SWEEP_AGE_S)
        .run()
        .catch(() => {}),
    );
    // 💻 THE TASK THAT NEVER ARRIVED. `use_device` hands the agent a claim
    // ticket after 45s — "The task was delivered; fetch the outcome later" — but
    // `delivered` only flips when the DEVICE polls. An envelope no device ever
    // picked up was silently DELETEd an hour later by the relay's opportunistic
    // sweep, and the promised ticket then answered "No result yet — the task may
    // still be running". Both sentences describe work in progress; the work
    // never started and every trace of it was gone. This says so, once, and
    // reaps what it reported in the same breath (there is no `reported` column —
    // the delete IS the idempotency). Never throws.
    ctx.waitUntil(sweepMissedTasks(env, Math.floor(Date.now() / 1000)));
    // 💸 THE RECONCILER. /pay/spend-reverse refuses to refund any reservation
    // whose signed authorization left us (c47) — correct, because we cannot see
    // whether the payee submitted it. That refusal is what keeps a landing
    // payment from being refunded, but on its own it also freezes the money
    // FOREVER for a payment that never landed. This is the other half: once the
    // authorization's own signed `validBefore` has passed, the chain can answer
    // definitively (`authorizationState(payer, nonce)`), so "unknown" gets
    // resolved into settled-or-refunded instead of sitting there. Per-minute,
    // small batch, and it never throws — a reconcile problem must not take down
    // job dispatch or the Telegram poll beside it.
    const sentSpends = reconcileSentSpends(env, Math.floor(Date.now() / 1000)).catch((err: any) => {
      console.log(err, "reconcileSentSpends");
    });
    ctx.waitUntil(sentSpends);
    // 🔍 THE RECEIVER'S HALF. The reconciler above makes a DEBITED PAYER whole;
    // this one pays a CREDITOR who was never paid — our x402 door 402s on an
    // unconfirmed settlement and credits nobody, so a settlement that then lands
    // leaves the tiny's owner unpaid for a request that really was paid for
    // (migration 0028). It asks a strictly stronger question than the payer side:
    // `authorizationState` is set by cancelAuthorization too, so crediting on that
    // bit would MINT — this reads the AuthorizationUsed log instead. Same
    // never-throws discipline, and it shares the tick's clock.
    const settleUnknown = reconcileSettleUnknown(env, Math.floor(Date.now() / 1000)).catch((err: any) => {
      console.log(err, "reconcileSettleUnknown");
    });
    ctx.waitUntil(settleUnknown);
    // 🚨 THE PAGER. Both reconcilers above drain what CAN be drained; neither can
    // tell anyone about what can't. `GET /pay/reconcile-status` (c53) made that
    // visible but nothing polls it, and an endpoint nobody reads is as unread as
    // the log line it replaced. This looks, once a minute, for free (zero RPC),
    // and speaks only when a HEAD-OF-LINE blocker or an identity-less reservation
    // persists across two consecutive ticks — never for mere queue depth, which
    // is the healthy state of `settle_unknown`.
    //
    // ⚠️ Sequenced AFTER both sweeps, deliberately: reading the queues first would
    // page about rows the same tick was about to retire. It is the last thing the
    // tick does and it never throws.
    ctx.waitUntil(
      Promise.all([sentSpends, settleUnknown])
        .then(() => sweepReconcileAlarm(env, Math.floor(Date.now() / 1000)))
        .catch((err: any) => { console.log(err, "sweepReconcileAlarm"); }),
    );
  },
  async email(message: any, env: any, ctx: any) {
    // Get the tiny.technology service by message.to's domain
    const name = message.to.split('@')[0];
    if (name === 'tiny') {
      // ADMIN_FORWARD_EMAIL must be a verified destination address on the zone's
      // Email Routing config; without it, mail to the apex local-part is rejected.
      if (env.ADMIN_FORWARD_EMAIL) {
        await message.forward(env.ADMIN_FORWARD_EMAIL);
      } else {
        message.setReject("no admin forward address configured");
      }
      return;
    }
    // Empty local-part (mail to "@tiny.technology") → env.tiny.get("") throws
    // on KV's empty-key rejection; reject cleanly instead.
    if (!name) { message.setReject("tiny is not exists"); return; }
    const db = await env.tiny.get(name, { type: "json" });
    console.log(`name: "${name}", got a email from "${message.from}" to: "${message.to}", Date: "${new Date().toISOString()}"`)

    // Missing return here used to fall through to db.customer.email and
    // crash the handler on any mail to a nonexistent tiny.
    if (!db) { message.setReject("tiny is not exists"); return; }
    if (!db.customer?.email) { message.setReject("tiny has no forwarding address"); return; }
    try {
      await message.forward(db.customer.email);
    } catch (e: any) {
      console.log(`name: ${name} got error when forwarding from ${message.from}`, e);
      console.log(e.error);

      console.log('Registering email address to Cloudflare...')

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN || ''}`,
        },
        body: JSON.stringify({ "email": db.customer.email })
      };

      try {
        // Stats for tiny
        const prefix = `tiny:fw:${name}`;
        const count = await env.stats.get(prefix);

        // KV put only accepts strings — a number throws (swallowed by this
        // catch), so the counter never persisted.
        if (!count) {
          await env.stats.put(prefix, "1");
        } else {
          await env.stats.put(prefix, String(Number(count) + 1));
        }
      } catch (err) {
        console.log(err);
      }

      // CF_ACCOUNT_ID is the deployer's own Cloudflare account (Dashboard →
      // Workers → right sidebar). It is a per-fork identifier, not a secret and
      // not a credential — CLOUDFLARE_API_TOKEN above is what authorizes the
      // call — but hardcoding one operator's account into a public template
      // makes every fork silently POST at THEM, so it is read from env like
      // every other binding and the route no-ops when unset.
      if (env.CF_ACCOUNT_ID) {
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`, options)
          .then(response => response.json())
          .then(response => console.log(response))
          .catch(err => console.error(err));
      }
      message.setReject("Error when forwarding");
    }
  },
}
