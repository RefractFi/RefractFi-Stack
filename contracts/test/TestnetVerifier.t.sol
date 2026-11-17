// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StreamsFeed, IStreamsVerifierProxy} from "../src/StreamsFeed.sol";
import {TestnetVerifier} from "../src/testnet/TestnetVerifier.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract TestnetVerifierTest is Test {
    bytes32 constant BTC = bytes32(uint256(0x0003) << 240 | 7);
    uint256 constant PUSHER_PK = 0xA11CE;
    uint256 constant OTHER_PK = 0xB0B;

    TestnetVerifier ver;
    StreamsFeed sf;

    function setUp() public {
        ver = new TestnetVerifier(address(this), vm.addr(PUSHER_PK));
        sf = new StreamsFeed(IStreamsVerifierProxy(address(ver)), address(0));
    }

    function _report(uint32 obs, int192 price) internal pure returns (bytes memory) {
        return abi.encode(BTC, obs, obs, uint192(0), uint192(0), obs + 60, price, price, price);
    }

    function _signed(uint256 pk, bytes memory reportData) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(keccak256(reportData)));
        bytes32[3] memory ctx;
        bytes32[] memory rs = new bytes32[](1);
        bytes32[] memory ss = new bytes32[](1);
        rs[0] = r;
        ss[0] = s;
        return abi.encode(ctx, reportData, rs, ss, bytes32(uint256(v)));
    }

    function _push(bytes memory full) internal {
        bytes[] memory a = new bytes[](1);
        a[0] = full;
        sf.push(a);
    }

    function test_signedReportIsStored() public {
        _push(_signed(PUSHER_PK, _report(1000, 90_000e18)));
        (int256 p, uint64 ts,) = sf.latest(BTC);
        assertEq(p, 90_000e18);
        assertEq(ts, 1000);
        (int256 at,) = sf.priceAt(BTC, 1000);
        assertEq(at, 90_000e18);
    }

    function test_foreignSignerReverts() public {
        bytes memory full = _signed(OTHER_PK, _report(1000, 1e18));
        vm.expectRevert(abi.encodeWithSelector(TestnetVerifier.BadSigner.selector, vm.addr(OTHER_PK)));
        _push(full);
    }

    function test_tamperedPriceReverts() public {
        bytes memory full = _signed(PUSHER_PK, _report(1000, 90_000e18));
        (bytes32[3] memory ctx,, bytes32[] memory rs, bytes32[] memory ss, bytes32 vs) =
            abi.decode(full, (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
        bytes memory forged = abi.encode(ctx, _report(1000, 1e18), rs, ss, vs);
        vm.expectRevert();
        _push(forged);
    }

    function test_unsignedReverts() public {
        bytes32[3] memory ctx;
        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(TestnetVerifier.BadSigner.selector, address(0)));
        _push(abi.encode(ctx, _report(1000, 1e18), none, none, bytes32(0)));
    }

    function test_onlyAdminRotatesSigner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TestnetVerifier.NotAdmin.selector);
        ver.setSigner(address(1));

        ver.setSigner(vm.addr(OTHER_PK));
        _push(_signed(OTHER_PK, _report(1005, 2e18)));
        (int256 p,,) = sf.latest(BTC);
        assertEq(p, 2e18);
    }
}
