#!/usr/bin/env node
/**
 * gen-onboarding-voice.mjs — ElevenLabs voiceover for the native onboarding
 * tour (iOS Onboarding.swift / Android Onboarding.kt, the shared 5-page
 * story: welcome → fleet → voice → everywhere → make-it-yours).
 *
 * Generates public/onboarding-voice/{lang}/p{0..4}.mp3 for every language
 * below — Vercel serves them; the apps pick the device language at runtime
 * and fall back to English. Scripts are SPOKEN copy (shorter and warmer than
 * the on-screen text) and platform-neutral: one clip set serves both apps.
 *
 *   ELEVENLABS_API_KEY=… node scripts/gen-onboarding-voice.mjs [lang…]
 *
 * Pass language codes to regenerate a subset (e.g. after a script tweak).
 * Voice: Sarah (mature, reassuring) on eleven_multilingual_v2 — the same
 * voice across all languages keeps the brand's sound consistent.
 * 64 kbps mp3 keeps each ~10s clip around 80 KB (whole set ≈ 6 MB, CDN-side
 * only — nothing is bundled into the apps).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Sarah
const MODEL = 'eleven_multilingual_v2'
const OUT = path.join(import.meta.dirname, '..', 'public', 'onboarding-voice')

/** lang → [p0 welcome, p1 fleet, p2 voice, p3 everywhere, p4 make-yours].
 *  Exported for tests/onboarding-voice.test.ts, which pins this language set
 *  to the generated assets and BOTH native clients' hardcoded lists. */
export const SCRIPTS = {
  en: [
    'Welcome to tiny — your own AI, free forever. Create it, chat with it, grow it. This app puts your tiny in your pocket.',
    'Sign in, and this phone joins your fleet. Your agent can reach it from anywhere — ask what’s around, and the phone answers.',
    'Talk to it. Voice mode keeps the mic open and understands you right on the device. Pause for a moment, and your thought sends itself. Replies can speak out loud.',
    'tiny lives beyond this app — widgets, voice, notifications. It keeps working even when the app is closed.',
    'Make it yours. Choose which tiny this app talks to — or keep the original. You can change it anytime.',
  ],
  tr: [
    'tiny’ye hoş geldin — kendi yapay zekân, sonsuza dek ücretsiz. Onu yarat, onunla konuş, onu büyüt. Bu uygulama tiny’ni cebine koyar.',
    'Giriş yap, bu telefon filona katılsın. Ajanın ona her yerden ulaşabilir — etrafta ne var diye sor, telefon cevaplasın.',
    'Onunla konuş. Ses modu mikrofonu açık tutar ve seni cihazın üzerinde anlar. Bir an duraksa, düşüncen kendiliğinden gönderilsin. Cevaplar sesli de okunabilir.',
    'tiny bu uygulamanın ötesinde yaşar — widget’lar, ses, bildirimler. Uygulama kapalıyken bile çalışmaya devam eder.',
    'Onu kendin yap. Bu uygulamanın hangi tiny ile konuşacağını seç — ya da orijinalinde kal. İstediğin zaman değiştirebilirsin.',
  ],
  de: [
    'Willkommen bei tiny — deine eigene KI, für immer kostenlos. Erschaffe sie, sprich mit ihr, lass sie wachsen. Diese App steckt dein tiny in deine Tasche.',
    'Melde dich an, und dieses Telefon wird Teil deiner Flotte. Dein Agent erreicht es von überall — frag, was in der Nähe ist, und das Telefon antwortet.',
    'Sprich mit ihm. Der Sprachmodus hält das Mikrofon offen und versteht dich direkt auf dem Gerät. Mach eine kurze Pause, und dein Gedanke sendet sich von selbst. Antworten können laut vorgelesen werden.',
    'tiny lebt über diese App hinaus — Widgets, Sprache, Benachrichtigungen. Es arbeitet weiter, auch wenn die App geschlossen ist.',
    'Mach es zu deinem. Wähle, mit welchem tiny diese App spricht — oder bleib beim Original. Du kannst es jederzeit ändern.',
  ],
  fr: [
    'Bienvenue sur tiny — ta propre IA, gratuite pour toujours. Crée-la, parle avec elle, fais-la grandir. Cette app met ton tiny dans ta poche.',
    'Connecte-toi, et ce téléphone rejoint ta flotte. Ton agent peut l’atteindre de n’importe où — demande ce qu’il y a autour, et le téléphone répond.',
    'Parle-lui. Le mode vocal garde le micro ouvert et te comprend directement sur l’appareil. Fais une pause, et ta pensée s’envoie toute seule. Les réponses peuvent être lues à voix haute.',
    'tiny vit au-delà de cette app — widgets, voix, notifications. Il continue de travailler même quand l’app est fermée.',
    'Fais-en le tien. Choisis avec quel tiny cette app discute — ou garde l’original. Tu peux changer à tout moment.',
  ],
  es: [
    'Bienvenido a tiny — tu propia IA, gratis para siempre. Créala, habla con ella, hazla crecer. Esta app pone tu tiny en tu bolsillo.',
    'Inicia sesión y este teléfono se une a tu flota. Tu agente puede alcanzarlo desde cualquier lugar — pregunta qué hay alrededor y el teléfono responde.',
    'Háblale. El modo de voz mantiene el micrófono abierto y te entiende en el propio dispositivo. Haz una pausa y tu idea se envía sola. Las respuestas pueden hablarte en voz alta.',
    'tiny vive más allá de esta app — widgets, voz, notificaciones. Sigue trabajando incluso con la app cerrada.',
    'Hazlo tuyo. Elige con qué tiny habla esta app — o quédate con el original. Puedes cambiarlo cuando quieras.',
  ],
  it: [
    'Benvenuto su tiny — la tua IA personale, gratis per sempre. Creala, parlaci, falla crescere. Questa app mette il tuo tiny in tasca.',
    'Accedi, e questo telefono entra nella tua flotta. Il tuo agente può raggiungerlo ovunque — chiedi cosa c’è intorno, e il telefono risponde.',
    'Parlaci. La modalità vocale tiene il microfono aperto e ti capisce direttamente sul dispositivo. Fai una pausa, e il tuo pensiero si invia da solo. Le risposte possono parlarti ad alta voce.',
    'tiny vive oltre questa app — widget, voce, notifiche. Continua a lavorare anche quando l’app è chiusa.',
    'Rendilo tuo. Scegli con quale tiny parla questa app — o tieni l’originale. Puoi cambiarlo quando vuoi.',
  ],
  pt: [
    'Bem-vindo ao tiny — a sua própria IA, grátis para sempre. Crie, converse, faça crescer. Este app coloca o seu tiny no seu bolso.',
    'Entre, e este telefone se junta à sua frota. Seu agente pode alcançá-lo de qualquer lugar — pergunte o que há por perto, e o telefone responde.',
    'Fale com ele. O modo de voz mantém o microfone aberto e entende você no próprio aparelho. Faça uma pausa, e o seu pensamento se envia sozinho. As respostas podem falar em voz alta.',
    'O tiny vive além deste app — widgets, voz, notificações. Ele continua trabalhando mesmo com o app fechado.',
    'Faça dele o seu. Escolha com qual tiny este app conversa — ou fique com o original. Você pode mudar quando quiser.',
  ],
  nl: [
    'Welkom bij tiny — je eigen AI, voor altijd gratis. Maak hem, praat ermee, laat hem groeien. Deze app stopt jouw tiny in je zak.',
    'Log in, en deze telefoon sluit zich aan bij je vloot. Je agent kan hem overal bereiken — vraag wat er in de buurt is, en de telefoon antwoordt.',
    'Praat ertegen. De spraakmodus houdt de microfoon open en verstaat je op het apparaat zelf. Pauzeer even, en je gedachte verstuurt zichzelf. Antwoorden kunnen hardop worden voorgelezen.',
    'tiny leeft verder dan deze app — widgets, spraak, meldingen. Hij blijft werken, ook als de app dicht is.',
    'Maak hem van jou. Kies met welke tiny deze app praat — of hou het origineel. Je kunt het altijd veranderen.',
  ],
  ru: [
    'Добро пожаловать в tiny — твой собственный ИИ, бесплатно навсегда. Создай его, говори с ним, расти его. Это приложение кладёт твоего tiny в карман.',
    'Войди — и этот телефон присоединится к твоему флоту. Твой агент дотянется до него откуда угодно: спроси, что вокруг, и телефон ответит.',
    'Поговори с ним. Голосовой режим держит микрофон открытым и понимает тебя прямо на устройстве. Сделай паузу — и мысль отправится сама. Ответы могут звучать вслух.',
    'tiny живёт за пределами этого приложения — виджеты, голос, уведомления. Он продолжает работать, даже когда приложение закрыто.',
    'Сделай его своим. Выбери, с каким tiny говорит это приложение, — или оставь оригинал. Поменять можно в любой момент.',
  ],
  ar: [
    'أهلاً بك في تايني — ذكاؤك الاصطناعي الخاص، مجاني للأبد. أنشئه، تحدّث معه، ونمّه. هذا التطبيق يضع تايني في جيبك.',
    'سجّل الدخول لينضم هذا الهاتف إلى أسطولك. يمكن لوكيلك الوصول إليه من أي مكان — اسأل عمّا حولك، والهاتف يجيب.',
    'تحدّث معه. وضع الصوت يبقي الميكروفون مفتوحاً ويفهمك على الجهاز نفسه. توقّف لحظة، وستُرسل فكرتك نفسها بنفسها. ويمكن للردود أن تُقرأ بصوتٍ عالٍ.',
    'تايني يعيش خارج هذا التطبيق — أدوات، صوت، إشعارات. يواصل العمل حتى عندما يكون التطبيق مغلقاً.',
    'اجعله لك. اختر أي تايني يتحدث معه هذا التطبيق — أو ابقَ مع الأصلي. يمكنك التغيير في أي وقت.',
  ],
  hi: [
    'tiny में आपका स्वागत है — आपका अपना AI, हमेशा के लिए मुफ़्त। इसे बनाइए, इससे बात कीजिए, इसे बढ़ाइए। यह ऐप आपके tiny को आपकी जेब में रख देता है।',
    'साइन इन कीजिए, और यह फ़ोन आपके बेड़े से जुड़ जाता है। आपका एजेंट इसे कहीं से भी पहुँच सकता है — पूछिए आस-पास क्या है, और फ़ोन जवाब देता है।',
    'इससे बात कीजिए। वॉइस मोड माइक खुला रखता है और आपको डिवाइस पर ही समझता है। थोड़ा रुकिए, और आपकी बात अपने आप भेज दी जाती है। जवाब बोलकर भी सुनाए जा सकते हैं।',
    'tiny इस ऐप से आगे भी रहता है — विजेट, आवाज़, सूचनाएँ। ऐप बंद होने पर भी यह काम करता रहता है।',
    'इसे अपना बनाइए। चुनिए कि यह ऐप किस tiny से बात करे — या मूल वाला ही रखिए। आप इसे कभी भी बदल सकते हैं।',
  ],
  ja: [
    'tinyへようこそ。あなただけのAI、ずっと無料。つくって、話して、育てて。このアプリで、あなたのtinyをポケットに。',
    'サインインすると、このスマホがあなたのフリートに加わります。エージェントはどこからでも届きます。まわりに何があるか聞けば、スマホが答えます。',
    '話しかけてみて。ボイスモードはマイクを開いたまま、端末の上であなたを理解します。少し黙れば、考えは自動で送信。返事は声で読み上げることもできます。',
    'tinyはこのアプリの外でも生きています。ウィジェット、音声、通知。アプリを閉じても働き続けます。',
    '自分のものにしよう。このアプリがどのtinyと話すかを選んで。そのままでもOK。いつでも変えられます。',
  ],
  ko: [
    'tiny에 오신 걸 환영해요 — 당신만의 AI, 영원히 무료. 만들고, 대화하고, 키워 보세요. 이 앱이 당신의 tiny를 주머니에 넣어 드려요.',
    '로그인하면 이 폰이 당신의 함대에 합류해요. 에이전트는 어디서든 닿을 수 있어요 — 주변에 뭐가 있는지 물으면 폰이 답해요.',
    '말을 걸어 보세요. 음성 모드는 마이크를 켜 둔 채 기기에서 바로 알아들어요. 잠시 멈추면 생각이 저절로 전송돼요. 답장은 소리 내어 읽어 줄 수도 있어요.',
    'tiny는 이 앱 너머에도 살아요 — 위젯, 음성, 알림. 앱을 닫아도 계속 일해요.',
    '당신의 것으로 만드세요. 이 앱이 어떤 tiny와 대화할지 고르세요 — 원래 것도 좋아요. 언제든 바꿀 수 있어요.',
  ],
  zh: [
    '欢迎来到 tiny——属于你自己的 AI，永久免费。创造它，与它对话，陪它成长。这个应用把你的 tiny 装进口袋。',
    '登录后，这台手机就加入你的舰队。你的智能体在任何地方都能联系到它——问问周围有什么，手机就会回答。',
    '跟它说话吧。语音模式让麦克风保持开启，并在设备上直接听懂你。停顿一下，想法就会自动发送。回复也可以大声读给你听。',
    'tiny 不止活在这个应用里——小组件、语音、通知。即使应用关闭，它也在继续工作。',
    '把它变成你的。选择这个应用和哪个 tiny 对话——或者保留原版。随时都能更改。',
  ],
}

async function main() {
  const KEY = process.env.ELEVENLABS_API_KEY
  if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1) }

  const only = process.argv.slice(2)
  const langs = only.length ? only : Object.keys(SCRIPTS)

  let made = 0, skipped = 0
  for (const lang of langs) {
    const pages = SCRIPTS[lang]
    if (!pages) { console.error(`no scripts for "${lang}"`); process.exit(1) }
    await mkdir(path.join(OUT, lang), { recursive: true })
    for (let p = 0; p < pages.length; p++) {
      const file = path.join(OUT, lang, `p${p}.mp3`)
      if (existsSync(file) && !only.length) { skipped++; continue } // incremental by default
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`,
        {
          method: 'POST',
          headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: pages[p], model_id: MODEL }),
        },
      )
      if (!res.ok) {
        console.error(`${lang}/p${p}: ${res.status} ${await res.text()}`)
        process.exit(1)
      }
      await writeFile(file, Buffer.from(await res.arrayBuffer()))
      made++
      console.log(`✓ ${lang}/p${p}.mp3`)
    }
  }
  console.log(`done — ${made} generated, ${skipped} kept`)
}

// Import-safe (tests import SCRIPTS); generation only runs as a CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
