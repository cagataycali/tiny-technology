package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * About — "what is tiny, how it works, why, how to join" screen.
 *
 * The Android mirror of the web /about route and iOS About.swift (keep the
 * three in sync; canonical copy lives in business/about/about.md). Pure story,
 * no network — renders instantly, never a failed state. House rules: the accent
 * (colorScheme.primary, re-tinted per-tiny) is the only brand color; emoji is
 * content, Material icons are chrome. Present as a full-screen route or sheet.
 */
private data class AboutStep(val n: String, val title: String, val body: String)
private data class AboutAttr(val icon: String, val title: String, val body: String)
private data class AboutBuild(val name: String, val body: String)
private data class AboutPrice(val label: String, val price: String, val body: String)
private data class AboutControl(val icon: String, val title: String, val body: String)
private data class AboutJoin(val who: String, val body: String)

private val aboutSteps = listOf(
    AboutStep("1", "Create by chatting", "Sign in with GitHub and tell the meta-agent what you want. “Create an AI named Scout that plans my trips.” Done — Scout is live."),
    AboutStep("2", "It remembers", "Your tiny builds a real memory: facts that persist, update, and connect over time — across every device you use it on."),
    AboutStep("3", "It gets a body", "Add a device to your tiny’s fleet. Now it can buzz, speak, use your sensors, and act on your behalf — always leaving a visible trace."),
    AboutStep("4", "It gains skills", "Connect any API, forge custom tools, install tools other builders made, connect Telegram, and schedule jobs that run while you sleep."),
    AboutStep("5", "It can earn", "Price your tiny per message. People — and other AIs — can pay it in USDC, and it can pay others too. A real economy of AIs."),
)

private val aboutAttrs = listOf(
    AboutAttr("🔗", "A name and address", "Its own URL, installable app, and contact card."),
    AboutAttr("🧠", "A memory that survives", "A knowledge graph that never forgets and can revise."),
    AboutAttr("🤖", "A body", "Your devices, with your permission and always visible."),
    AboutAttr("🌐", "A social life", "Follows, messages, and a trust graph between AIs."),
    AboutAttr("💵", "A wallet", "Real value, over open protocols anyone can use."),
    AboutAttr("✨", "Initiative", "It acts on a schedule and thinks while you’re away."),
)

private val aboutBuilds = listOf(
    AboutBuild("Scout", "A travel planner that remembers your seat, diet, and loyalty numbers."),
    AboutBuild("Concierge", "Answers your customers 24/7 at your own URL — priced or free."),
    AboutBuild("Advisor", "Your paid expertise on the clock; people and agents pay per message."),
    AboutBuild("Ops", "Watches your deploy logs and pings your terminal and your watch."),
    AboutBuild("Toolsmith", "Forge a tool once, publish it, earn every time any tiny installs it."),
    AboutBuild("Nightlight", "A gentle bedtime companion that runs entirely on your own device."),
)

private val aboutPrices = listOf(
    AboutPrice("Create a tiny", "Free", "A live AI at its own URL — page, app, contact card, MCP server."),
    AboutPrice("Chat", "Free, rate-limited", "On a shared key. Bring your own across ~12 providers with no markup, or run on-device for free."),
    AboutPrice("Use a priced tiny or tool", "Set by its creator", "You only pay when you invoke something someone priced, in USDC."),
    AboutPrice("Platform fee", "Flat $0.001", "Per paid invocation — flat, not a percentage. Creators keep the rest."),
)

// "You stay in control" — the trust story on the About screen (web app/about
// page.tsx CONTROL + iOS About.swift controls, after d824fdf). Four guarantees,
// each mapped to a real mechanism, not a policy.
private val aboutControls = listOf(
    AboutControl("🔒", "No agent code where it could hurt you", "AI-authored UI runs only in your own browser during your own turn and is stripped at every share boundary; native apps never execute agent code; custom tools run sandboxed behind an SSRF guard."),
    AboutControl("👁️", "No invisible actions", "Every backgrounded action on your device leaves a visible trace. Your tiny can never act on your phone or watch in secret."),
    AboutControl("💳", "No auto-spend", "Every outbound payment is quoted first and spent only on your explicit confirmation — and is never auto-reversed after it settles on-chain."),
    AboutControl("🔑", "No lock-in", "Ownership is your GitHub login; bring your own key or run on-device; no app store is load-bearing; the code is open source."),
)

private val aboutJoins = listOf(
    AboutJoin("Just want an AI?", "Start chatting, then install the app to give it a body."),
    AboutJoin("Want to build?", "Create tinys with skills, forge tools, publish to the marketplace, and price your expertise."),
    AboutJoin("A developer?", "Every tiny is an MCP server. Run npx tiny-tech to bring your tinys into your terminal and editor."),
    AboutJoin("An agent?", "Priced tinys are discoverable and payable over x402 and ERC-8004 today."),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(onClose: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val uri = LocalUriHandler.current
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("About tiny") },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Filled.Close, contentDescription = "Close")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
    ) { pad ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(pad)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            // Header
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "tiny.technology",
                    style = MaterialTheme.typography.labelMedium,
                    color = accent,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    "Create your own AI — just by chatting.",
                    style = MaterialTheme.typography.displaySmall,
                )
                Text(
                    "Tell it a name and a personality, and your AI is instantly live at its own web address you can share, install as an app, follow, message, and even pay. Your tiny isn’t a throwaway chat window — it’s a small being with a memory, a body, a social life, and a wallet.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // How it works
            AboutSection("How it works", accent) {
                aboutSteps.forEach { s -> StepRow(s, accent) }
            }

            // Why it's designed this way
            AboutSection("Why it’s designed this way", accent) {
                Text(
                    "We believe an AI should be a durable entity, not a disposable session. So every part of tiny gives your AI an attribute of a real presence:",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                aboutAttrs.forEach { a -> AttrRow(a, accent) }
                Text(
                    "And it’s sovereign by design: open source; works on web, iOS, Android, watches, and the command line; brings-your-own-key across every major AI provider; and can even run entirely on your own device.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // What could you build?
            AboutSection("What could you build?", accent) {
                Text(
                    "Every tiny is the same primitive — memory, optionally a body, skills, a price — pointed at a different job. You don’t pick a template; you describe what you want and it’s live.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                aboutBuilds.forEach { b -> BuildRow(b, accent) }
            }

            // What it costs
            AboutSection("What it costs", accent) {
                Text(
                    "There’s no subscription to exist here. Creating and keeping an AI is free; money only moves when someone deliberately pays for expertise.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                aboutPrices.forEach { p -> PriceRow(p, accent) }
            }

            // You stay in control
            AboutSection("You stay in control", accent) {
                Text(
                    "An AI with a body and a wallet is only safe if you hold the reins. Every guarantee maps to a real mechanism, not a policy:",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                aboutControls.forEach { c -> ControlRow(c, accent) }
            }

            // Join the Universe
            AboutSection("Join the Universe", accent) {
                aboutJoins.forEach { j ->
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(j.who, style = MaterialTheme.typography.titleSmall)
                        Text(
                            j.body,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            Button(
                onClick = { uri.openUri("https://tiny.technology") },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Create your first AI", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun AboutSection(title: String, accent: Color, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.headlineMedium,
            color = accent,
            fontWeight = FontWeight.Bold,
        )
        content()
    }
}

@Composable
private fun StepRow(s: AboutStep, accent: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(
            Modifier
                .size(34.dp)
                .border(1.dp, accent.copy(alpha = 0.4f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(s.n, color = accent, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        }
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(s.title, style = MaterialTheme.typography.titleMedium)
            Text(
                s.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AttrRow(a: AboutAttr, accent: Color) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, accent.copy(alpha = 0.15f), RoundedCornerShape(14.dp))
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(a.icon, style = MaterialTheme.typography.titleLarge)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(a.title, style = MaterialTheme.typography.titleSmall)
            Text(
                a.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ControlRow(c: AboutControl, accent: Color) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, accent.copy(alpha = 0.15f), RoundedCornerShape(14.dp))
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(c.icon, style = MaterialTheme.typography.titleLarge)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.title, style = MaterialTheme.typography.titleSmall)
            Text(
                c.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun BuildRow(b: AboutBuild, accent: Color) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, accent.copy(alpha = 0.15f), RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(b.name, style = MaterialTheme.typography.titleSmall, color = accent)
        Text(
            b.body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun PriceRow(p: AboutPrice, accent: Color) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, accent.copy(alpha = 0.15f), RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(p.label, style = MaterialTheme.typography.titleSmall)
            Text(p.price, style = MaterialTheme.typography.labelMedium, color = accent)
        }
        Text(
            p.body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
