/*
 * FomoServos — the "Servos" tab: six rows (base, shoulder_lift, elbow, wrist_flex, pan, tilt), each with the present
 * reading, its offset from home, a slider over the guard's calibrated window (absolute servo degrees), ±1°/±5°
 * steppers and a torque switch. Dragging sends POST /api/control/move {"actions":[{"joint":<servo>,"to":<deg>}]}
 * coalesced latest-wins at ≤ 10 Hz (FomoManager.moveServo); release sends the final target. The twin ghost previews
 * the target live; a guard refusal (422/409) shows verbatim under the row and the ghost snaps back to the reading.
 * STOP stays visible at the top. Identifiers: fomo-servos, fomo-servo-<name>, fomo-servo-<name>-slider/-minus5/
 * -minus1/-plus1/-plus5/-torque/-reading/-refusal.
 */

import SwiftUI

struct FomoServosTab: View {
    @ObservedObject var fomo: FomoManager

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                FomoStopButton(fomo: fomo, large: true).accessibilityIdentifier("fomo-servos-stop")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Each servo, absolute degrees. Slider = the guard's calibrated window.")
                        .font(.caption2).foregroundStyle(.secondary)
                    Text(fomo.state?.busy.map { "busy: \($0)" } ?? (fomo.stateFresh ? "arm idle" : "waiting for a reading…"))
                        .font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("fomo-servos-busy")
                }
            }
            ForEach(FomoTwinMath.joints) { j in
                FomoServoRow(fomo: fomo, joint: j)
            }
            if let r = fomo.lastRefusal {
                Text(r).font(.caption2).foregroundStyle(.red)
                    .accessibilityIdentifier("fomo-servos-refusal")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-servos")
    }
}

struct FomoServoRow: View {
    @ObservedObject var fomo: FomoManager
    let joint: FomoTwinMath.Joint
    @State private var dragging = false
    @State private var value: Double = 180

    private var reading: FomoCore.Joint? { fomo.state?.joints.first { $0.id == joint.id } }
    private var window: ClosedRange<Double> { fomo.servoWindow(joint.id) }
    private var target: Double? { fomo.commandedDegrees?[joint.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(joint.servo).font(.subheadline.weight(.semibold))
                Text(reading.map { String(format: "%.1f°", $0.deg) } ?? "—")
                    .font(.subheadline.monospacedDigit())
                    .accessibilityIdentifier("fomo-servo-\(joint.servo)-reading")
                Text(reading.map { String(format: "(%+.1f from home)", $0.rel) } ?? "")
                    .font(.caption2).foregroundStyle(.secondary)
                if let t = target, reading.map({ abs(FomoTwinMath.wrap(t - $0.deg)) > 0.3 }) ?? true {
                    Text(String(format: "→ %.1f°", t)).font(.caption.monospacedDigit()).foregroundStyle(.blue)
                        .accessibilityIdentifier("fomo-servo-\(joint.servo)-target")
                }
                Spacer()
                Toggle(isOn: Binding(get: { reading?.torque ?? false }, set: { fomo.servoTorque(joint.id, $0) })) {
                    Image(systemName: "bolt.fill")
                }
                .toggleStyle(.button).controlSize(.small)
                .accessibilityLabel("torque \(joint.servo)")
                .accessibilityIdentifier("fomo-servo-\(joint.servo)-torque")
            }
            HStack(spacing: 6) {
                step(-5, "fomo-servo-\(joint.servo)-minus5")
                step(-1, "fomo-servo-\(joint.servo)-minus1")
                Slider(value: Binding(get: { dragging ? value : (target ?? reading?.deg ?? value) },
                                      set: { v in value = v; fomo.moveServo(joint.id, to: v) }),
                       in: window,
                       onEditingChanged: { editing in
                           dragging = editing
                           if !editing { fomo.moveServo(joint.id, to: value, final: true) }
                       })
                .disabled(reading == nil)
                .accessibilityIdentifier("fomo-servo-\(joint.servo)-slider")
                step(1, "fomo-servo-\(joint.servo)-plus1")
                step(5, "fomo-servo-\(joint.servo)-plus5")
            }
            HStack {
                Text(String(format: "%.0f°", window.lowerBound)).font(.caption2).foregroundStyle(.tertiary)
                Spacer()
                if fomo.servoPending[joint.id] != nil { ProgressView().controlSize(.mini) }
                Text(String(format: "%.0f°", window.upperBound)).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-servo-\(joint.servo)")
        .accessibilityValue("\(reading.map { String(format: "%.1f", $0.deg) } ?? "-") window \(Int(window.lowerBound))-\(Int(window.upperBound)) torque=\(reading?.torque ?? false)")
        .onAppear { if let r = reading { value = r.deg } }
    }

    private func step(_ d: Double, _ id: String) -> some View {
        Button {
            let base = target ?? reading?.deg ?? value
            value = base + d
            fomo.moveServo(joint.id, to: value, final: true)
            TinyDesign.haptic(.light)
        } label: {
            Text(d > 0 ? "+\(Int(d))" : "\(Int(d))").font(.caption.monospacedDigit()).frame(minWidth: 26)
        }
        .buttonStyle(.bordered).controlSize(.small)
        .disabled(reading == nil)
        .accessibilityIdentifier(id)
    }
}

/// The "Twin" tab: the native twin (tall) with the joint HUD under it.
struct FomoTwinTab: View {
    @ObservedObject var fomo: FomoManager

    var body: some View {
        VStack(spacing: 10) {
            FomoTwinView(fomo: fomo)
                .frame(height: 300)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            FomoTwinHUD(fomo: fomo)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-twin-tab")
    }
}
