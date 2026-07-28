// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * MockCourt — a court that misbehaves on purpose. TEST FIXTURE, never deployed
 * as part of the chain.
 *
 * `TinyValidatorsSlashable` claims in its header that a broken court cannot
 * freeze the registry: reads are fail-open and gas-bounded. Two of the three
 * failure shapes can be produced without any fixture at all — an EOA court
 * (staticcall succeeds, returns nothing) and a wrong-contract court (no matching
 * selector, reverts). The third cannot: a court that ANSWERS but burns every
 * drop of gas doing it. That is the shape the COURT_GAS bound exists for, and
 * without this contract the bound would be an untested sentence in a docblock —
 * which is how a guard ends up being wrong for a year while looking careful.
 *
 * Modes:
 *   0 — honest: answers false for everyone.
 *   1 — gas bomb: loops until the call frame is out of gas.
 *   2 — short return: returns 31 bytes, one short of a decodable bool.
 */
contract MockCourt {
    uint8 public immutable mode;
    uint256 private sink;

    constructor(uint8 _mode) {
        mode = _mode;
    }

    function isEquivocator(address) external view returns (bool) {
        if (mode == 1) {
            // Spin on a view function. `sink` is read (not written) so this stays
            // callable via staticcall — a write would revert for the wrong reason
            // and the test would pass while proving nothing about gas.
            uint256 acc = sink;
            for (uint256 i = 0; i < type(uint256).max; i++) {
                acc = uint256(keccak256(abi.encode(acc, i)));
            }
            return acc == 0;
        }
        if (mode == 2) {
            assembly {
                return(0, 31)
            }
        }
        return false;
    }
}
