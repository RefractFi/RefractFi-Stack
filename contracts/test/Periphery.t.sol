// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StreamsFeed, IStreamsVerifierProxy} from "../src/StreamsFeed.sol";
import {TraceRoots} from "../src/TraceRoots.sol";
import {SpectrumRegistry} from "../src/SpectrumRegistry.sol";
import {MockVerifier} from "./Mocks.sol";

contract PeripheryTest is Test {
    StreamsFeed sf;
    bytes32 constant V3 = bytes32(uint256(0x0003) << 240 | 7);
    bytes32 constant V8 = bytes32(uint256(0x0008) << 240 | 9);

    function setUp() public {
        sf = new StreamsFeed(IStreamsVerifierProxy(address(new MockVerifier())), address(0));
    }

    function _wrap(bytes memory reportData) internal pure returns (bytes memory) {
        bytes32[3] memory ctx;
        bytes32[] memory rs = new bytes32[](0);
        return abi.encode(ctx, reportData, rs, rs, bytes32(0));
    }

    function _v3(uint32 obs, int192 price) internal pure returns (bytes memory) {
        return _wrap(abi.encode(V3, obs, obs, uint192(0), uint192(0), obs + 60, price, price - 1, price + 1));
    }

    function _v8(uint32 obs, int192 mid, uint32 status) internal pure returns (bytes memory) {
        return _wrap(abi.encode(V8, obs, obs, uint192(0), uint192(0), obs + 60, uint64(obs), mid, status));
    }

    function test_streams_v3_and_v8() public {
        bytes[] memory r = new bytes[](2);
        r[0] = _v3(1000, 100_000e18);
        r[1] = _v8(1000, 201e18, 1);
        sf.push(r);
        (int256 p, uint64 ts, bool open) = sf.latest(V3);
        assertEq(p, 100_000e18);
        assertEq(ts, 1000);
        assertTrue(open);
        (p,, open) = sf.latest(V8);
        assertEq(p, 201e18);
        assertFalse(open); // market closed: price held
    }

    function test_streams_onlyNewerReplaces() public {
        bytes[] memory r = new bytes[](1);
        r[0] = _v3(2000, 100e18);
        sf.push(r);
        r[0] = _v3(1500, 999e18);
        sf.push(r);
        (int256 p,,) = sf.latest(V3);
        assertEq(p, 100e18);
    }

    function test_streams_priceAtExactObservation() public {
        bytes[] memory r = new bytes[](2);
        r[0] = _v3(3000, 101e18);
        r[1] = _v3(3005, 105e18);
        sf.push(r);
        (int256 p,) = sf.priceAt(V3, 3000);
        assertEq(p, 101e18); // an older report stays addressable for window settlement
        (p,) = sf.priceAt(V3, 3005);
        assertEq(p, 105e18);
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.NoPriceAt.selector, V3, uint64(3001)));
        sf.priceAt(V3, 3001);
    }

    function test_streams_rejectsUnknownSchema() public {
        bytes32 v5 = bytes32(uint256(0x0005) << 240);
        bytes[] memory r = new bytes[](1);
        r[0] = _wrap(abi.encode(v5, uint32(1), uint32(1)));
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.UnknownSchema.selector, uint16(5)));
        sf.push(r);
    }

    function test_traceRoots_sequentialAndProves() public {
        address poster = makeAddr("poster");
        TraceRoots tr = new TraceRoots(poster);
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        vm.expectRevert(TraceRoots.NotPoster.selector);
        tr.commit(1, root, 2);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(TraceRoots.OutOfOrder.selector, uint64(1), uint64(2)));
        tr.commit(2, root, 2);
        vm.prank(poster);
        tr.commit(1, root, 2);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = b;
        assertTrue(tr.proves(1, a, proof));
        assertFalse(tr.proves(1, keccak256("c"), proof));
        assertFalse(tr.proves(2, a, proof));
    }

    function test_spectrum_feeCap() public {
        SpectrumRegistry reg = new SpectrumRegistry();
        vm.expectRevert(SpectrumRegistry.FeeTooHigh.selector);
        reg.list(3001, "ipfs://x");
        reg.list(2000, "ipfs://card");
        (uint16 fee, bool active,,) = reg.listings(address(this));
        assertEq(fee, 2000);
        assertTrue(active);
        reg.delist();
        (, active,,) = reg.listings(address(this));
        assertFalse(active);
    }
}
