import XCTest
@testable import Tiny

/**
 * The agent map bridge's contract mirrors web tests/map-tools.test.ts and
 * Android AgentMapTest.kt: id'd pins (re-use moves), coordinate/zoom/pause
 * clamps, tour stops filtered to KNOWN pins capped at 12, hex→rgb with a
 * junk fallback. handle() is exercised through JSON strings — the exact
 * shape the stream decoder hands it.
 */
@MainActor
final class AgentMapTests: XCTestCase {

    override func tearDown() {
        AgentMap.shared.resetForTest()
        super.tearDown()
    }

    private func handle(_ name: String, _ json: String) -> Bool {
        AgentMap.shared.handle(name: name, argsJson: json)
    }

    func testAddStoresPinUnderAgentChosenId() {
        XCTAssertTrue(handle("add_map_marker", #"{"lat":37.7749,"lng":-122.4194,"id":"stop-1","label":"coffee"}"#))
        let pin = AgentMap.shared.pins["stop-1"]
        XCTAssertEqual(pin?.lat, 37.7749)
        XCTAssertEqual(pin?.label, "coffee")
    }

    func testAddWithoutIdAutoAssignsAndReusedIdMoves() {
        _ = handle("add_map_marker", #"{"lat":1,"lng":2}"#)
        XCTAssertNotNil(AgentMap.shared.pins["pin-1"])
        _ = handle("add_map_marker", #"{"lat":3,"lng":4,"id":"a"}"#)
        _ = handle("add_map_marker", #"{"lat":5,"lng":6,"id":"a"}"#)
        XCTAssertEqual(AgentMap.shared.pins.count, 2)
        XCTAssertEqual(AgentMap.shared.pins["a"]?.lat, 5)
    }

    func testAddRejectsOutOfRangeCoordsButStillClaimsTheTool() {
        XCTAssertTrue(handle("add_map_marker", #"{"lat":91,"lng":0}"#))
        XCTAssertTrue(handle("add_map_marker", #"{"lat":0,"lng":-181}"#))
        XCTAssertTrue(handle("add_map_marker", #"{"lng":-122.4}"#))
        XCTAssertTrue(AgentMap.shared.pins.isEmpty)
    }

    func testClearPinsIsTheUserFacingEraser() {
        _ = handle("add_map_marker", #"{"lat":1,"lng":2,"id":"a"}"#)
        _ = handle("add_map_marker", #"{"lat":3,"lng":4,"id":"b"}"#)
        AgentMap.shared.clearPins()
        XCTAssertTrue(AgentMap.shared.pins.isEmpty)
    }

    func testRemoveAndClearDropPins() {
        _ = handle("add_map_marker", #"{"lat":1,"lng":2,"id":"a"}"#)
        _ = handle("add_map_marker", #"{"lat":3,"lng":4,"id":"b"}"#)
        _ = handle("remove_map_marker", #"{"id":"a"}"#)
        XCTAssertEqual(Set(AgentMap.shared.pins.keys), ["b"])
        _ = handle("clear_map_markers", #"{"confirm":true}"#)
        XCTAssertTrue(AgentMap.shared.pins.isEmpty)
    }

    func testFlyToLocationEmitsCameraWithClampedZoom() {
        _ = handle("fly_to_location", #"{"lat":41.0082,"lng":28.9784,"zoom":12}"#)
        XCTAssertEqual(AgentMap.shared.camera?.lat, 41.0082)
        XCTAssertEqual(AgentMap.shared.camera?.zoom, 12)
        _ = handle("fly_to_location", #"{"lat":1,"lng":2,"zoom":99}"#)
        XCTAssertEqual(AgentMap.shared.camera?.zoom, 20)
    }

    func testPinRefsResolveByLabelWhenTheIdMisses() {
        // The model skipped the optional id (auto pin-1), then referenced
        // the LABEL — the exact field failure behind "fly doesn't work".
        _ = handle("add_map_marker", #"{"lat":37.8,"lng":-122.27,"label":"Coffee"}"#)
        _ = handle("fly_to_marker", #"{"id":"coffee"}"#)
        XCTAssertEqual(AgentMap.shared.camera?.lat, 37.8)
        _ = handle("remove_map_marker", #"{"id":"COFFEE"}"#)
        XCTAssertTrue(AgentMap.shared.pins.isEmpty)
    }

    func testExactIdStillWinsOverALabelCollision() {
        _ = handle("add_map_marker", #"{"lat":1,"lng":2,"id":"a","label":"b"}"#)
        _ = handle("add_map_marker", #"{"lat":3,"lng":4,"id":"b","label":"a"}"#)
        _ = handle("fly_to_marker", #"{"id":"b"}"#) // the id "b", not label "b"
        XCTAssertEqual(AgentMap.shared.camera?.lat, 3)
    }

    func testFlyToMarkerUsesStoredPinAndIgnoresUnknownIds() {
        _ = handle("add_map_marker", #"{"lat":7,"lng":8,"id":"a"}"#)
        _ = handle("fly_to_marker", #"{"id":"a"}"#)
        XCTAssertEqual(AgentMap.shared.camera?.lat, 7)
        let seq = AgentMap.shared.camera?.seq
        _ = handle("fly_to_marker", #"{"id":"ghost"}"#)
        XCTAssertEqual(AgentMap.shared.camera?.seq, seq)
    }

    func testCameraSeqIsMonotonicSoOnChangeFiresForRepeats() {
        _ = handle("fly_to_location", #"{"lat":1,"lng":2}"#)
        let first = AgentMap.shared.camera
        _ = handle("fly_to_location", #"{"lat":1,"lng":2}"#)
        XCTAssertNotEqual(AgentMap.shared.camera, first)
        XCTAssertEqual(AgentMap.shared.camera?.seq, 2)
    }

    func testNonMapToolsAreNotClaimed() {
        XCTAssertFalse(handle("vibrate", #"{"pattern":"tap"}"#))
    }

    func testSpotlightRisesOnGestureAndDecays() async throws {
        AgentMap.shared.spotlightSeconds = 0.05
        XCTAssertFalse(AgentMap.shared.spotlight)
        _ = handle("fly_to_location", #"{"lat":1,"lng":2}"#)
        XCTAssertTrue(AgentMap.shared.spotlight)
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertFalse(AgentMap.shared.spotlight)
    }

    func testAgentGestureSuspendsTheFollowLoop() {
        XCTAssertFalse(AgentMap.shared.followSuspended)
        _ = handle("fly_to_location", #"{"lat":1,"lng":2}"#)
        XCTAssertTrue(AgentMap.shared.followSuspended)
        AgentMap.shared.resetForTest()
        XCTAssertFalse(AgentMap.shared.followSuspended)
    }

    func testVisibilityCounterTracksMountedSurfacesAndFloorsAtZero() {
        XCTAssertFalse(AgentMap.shared.mapVisible)
        AgentMap.shared.mapDidAppear()
        AgentMap.shared.mapDidAppear() // ambient + full-screen at once
        AgentMap.shared.mapDidDisappear()
        XCTAssertTrue(AgentMap.shared.mapVisible)
        AgentMap.shared.mapDidDisappear()
        AgentMap.shared.mapDidDisappear() // over-release must not go negative
        XCTAssertFalse(AgentMap.shared.mapVisible)
        AgentMap.shared.mapDidAppear()
        XCTAssertTrue(AgentMap.shared.mapVisible)
    }

    // MARK: - pure helpers

    func testTourStopsFilterUnknownKeepOrderAndCapAtTwelve() {
        var pins: [String: AgentMap.Pin] = [:]
        for i in 1...15 {
            pins["p\(i)"] = AgentMap.Pin(id: "p\(i)", lat: Double(i), lng: 0, label: nil, color: nil)
        }
        let ids: [Any] = (1...15).reversed().map { "p\($0)" } + ["ghost"]
        let stops = AgentMap.tourStops(["ids": ids], pins: pins)
        XCTAssertEqual(stops.count, 12)
        XCTAssertEqual(stops.first?.id, "p15")
        XCTAssertNil(stops.first(where: { $0.id == "ghost" }))
    }

    func testTourPauseClampsToWebBridgeBounds() {
        XCTAssertEqual(AgentMap.tourPauseMs([:]), 2000)
        XCTAssertEqual(AgentMap.tourPauseMs(["pause_ms": 100]), 500)
        XCTAssertEqual(AgentMap.tourPauseMs(["pause_ms": 60_000]), 10_000)
    }

    func testSpanDegreesHalvesPerZoomLevelAndDefaultsStreetsIsh() {
        XCTAssertEqual(AgentMap.spanDegrees(forZoom: nil), 0.02)
        XCTAssertEqual(AgentMap.spanDegrees(forZoom: 10), 360.0 / 1024.0, accuracy: 1e-9)
        XCTAssertEqual(AgentMap.spanDegrees(forZoom: 11), AgentMap.spanDegrees(forZoom: 10) / 2, accuracy: 1e-9)
    }

    func testRgbParsesHexAndRejectsJunk() {
        XCTAssertEqual(AgentMap.rgb(fromHex: "#ff0000")?.r, 1)
        XCTAssertEqual(AgentMap.rgb(fromHex: "#00f")?.b, 1)
        XCTAssertNil(AgentMap.rgb(fromHex: "tomato"))
        XCTAssertNil(AgentMap.rgb(fromHex: nil))
        XCTAssertNil(AgentMap.rgb(fromHex: "#12345"))
    }
}
