package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SpawnTree.applyResults — folds the spawn_agents tool-result JSON
 * ({elapsed_ms, results:[{task, ok, result?, error?}]}) onto the running node
 * list, the Android twin of iOS TaskTree.apply() / web TaskTree nodeFor. The
 * contract that must match both other clients:
 *   - match a result to its node by 1-based `task` id
 *   - a node's text is `result` when present, else `error`
 *   - a reported node's ok comes from the payload (defaulting false)
 *   - ANY unreported node flips to failure (batch-timeout isolation)
 *   - malformed JSON leaves the tree untouched (still all "running")
 * This is applyResults' first-ever coverage (it shipped untested).
 */
class TaskTreeTest {

    private fun running(vararg prompts: String) = SpawnTree(
        id = "tool-1",
        nodes = prompts.mapIndexed { i, p -> SpawnNode(id = i + 1, prompt = p) },
    )

    @Test fun `matches results to nodes by 1-based task id and sets ok plus result`() {
        val tree = running("research A", "research B").applyResults(
            """{"elapsed_ms":1234.5,"results":[
                {"task":1,"ok":true,"result":"found A"},
                {"task":2,"ok":true,"result":"found B"}]}"""
        )
        assertEquals(1234.5, tree.elapsedMs!!, 0.001)
        assertEquals(true, tree.nodes[0].ok); assertEquals("found A", tree.nodes[0].result)
        assertEquals(true, tree.nodes[1].ok); assertEquals("found B", tree.nodes[1].result)
    }

    @Test fun `a failed sub-agent surfaces its error text when no result is present`() {
        val tree = running("do X").applyResults(
            """{"results":[{"task":1,"ok":false,"error":"agent timed out"}]}"""
        )
        assertFalse(tree.nodes[0].ok!!)
        assertEquals("agent timed out", tree.nodes[0].result)
    }

    @Test fun `result wins over error when both are present`() {
        val tree = running("do X").applyResults(
            """{"results":[{"task":1,"ok":true,"result":"the answer","error":"ignored"}]}"""
        )
        assertEquals("the answer", tree.nodes[0].result)
    }

    @Test fun `an unreported node flips to failure — batch-timeout isolation`() {
        // Only task 1 comes back; task 2 was never reported → it must read ✗,
        // not stay a forever-spinner (matches iOS's `ok == nil → false` sweep).
        val tree = running("A", "B").applyResults(
            """{"results":[{"task":1,"ok":true,"result":"A done"}]}"""
        )
        assertEquals(true, tree.nodes[0].ok)
        assertFalse(tree.nodes[1].ok!!)     // unreported → failure
        assertNull(tree.nodes[1].result)    // no text for a node that never reported
    }

    @Test fun `ok defaults to false when the result omits the ok flag`() {
        val tree = running("A").applyResults("""{"results":[{"task":1,"result":"partial"}]}""")
        assertFalse(tree.nodes[0].ok!!)
        assertEquals("partial", tree.nodes[0].result)
    }

    @Test fun `a result for an unknown task id is ignored, its node still fails`() {
        val tree = running("A").applyResults(
            """{"results":[{"task":9,"ok":true,"result":"orphan"}]}"""
        )
        // task 9 has no node → skipped; the real node 1 was unreported → fails.
        assertFalse(tree.nodes[0].ok!!)
        assertNull(tree.nodes[0].result)
    }

    @Test fun `malformed JSON leaves the tree untouched — every node still running`() {
        val before = running("A", "B")
        val after = before.applyResults("not json {{{")
        assertNull(after.nodes[0].ok)  // still running
        assertNull(after.nodes[1].ok)
        assertNull(after.elapsedMs)
    }

    @Test fun `absent results array flips every node to failure`() {
        // A well-formed payload with no results (all agents lost) → all ✗.
        val tree = running("A", "B").applyResults("""{"elapsed_ms":10.0}""")
        assertFalse(tree.nodes[0].ok!!)
        assertFalse(tree.nodes[1].ok!!)
        assertEquals(10.0, tree.elapsedMs!!, 0.001)
    }
}
