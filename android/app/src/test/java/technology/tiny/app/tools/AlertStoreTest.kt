package technology.tiny.app.tools

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure pending-alert filter+sort (behind AlertStore.loadPending) — what the Jobs
 * panel lists for agent-scheduled schedule_alert notifications: only alerts still
 * in the future, soonest first. A `>=` slip would surface an already-fired alert; a
 * bad sort would misorder the countdown. Pure Kotlin (the SharedPreferences I/O is
 * exercised on-device).
 */
class AlertStoreTest {

    private fun rec(id: String, fireAt: Long) = AlertRecord(id, "t-$id", "b-$id", fireAt)

    @Test fun `keeps only future alerts, drops past ones`() {
        val out = AlertStore.pendingFrom(
            listOf(rec("past", 500), rec("future", 1500)),
            now = 1000,
        )
        assertEquals(listOf("future"), out.map { it.id })
    }

    @Test fun `an alert firing exactly now is NOT pending (strict greater-than)`() {
        // fireAt == now has already been handed to the user this instant.
        val out = AlertStore.pendingFrom(listOf(rec("nowish", 1000)), now = 1000)
        assertEquals(emptyList<String>(), out.map { it.id })
    }

    @Test fun `sorts soonest first regardless of input order`() {
        val out = AlertStore.pendingFrom(
            listOf(rec("c", 3000), rec("a", 1200), rec("b", 2000)),
            now = 1000,
        )
        assertEquals(listOf("a", "b", "c"), out.map { it.id })
    }

    @Test fun `an empty store yields nothing`() {
        assertEquals(emptyList<AlertRecord>(), AlertStore.pendingFrom(emptyList(), now = 1000))
    }

    @Test fun `all-past yields empty`() {
        val out = AlertStore.pendingFrom(listOf(rec("a", 100), rec("b", 200)), now = 1000)
        assertEquals(emptyList<String>(), out.map { it.id })
    }
}
