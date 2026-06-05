// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Minimal stub that emits the ERC-7984 events our indexer watches.
/// The amount field is bytes32 (the euint64 ciphertext handle) — any value works.
contract MockToken {
    event ConfidentialTransfer(
        address indexed from,
        address indexed to,
        bytes32 indexed amount
    );

    event AmountDisclosed(
        bytes32 indexed encryptedAmount,
        uint64 amount
    );

    event UnwrapRequested(
        address indexed receiver,
        bytes32 indexed unwrapRequestId,
        bytes32 amount
    );

    event UnwrapFinalized(
        address indexed receiver,
        bytes32 indexed unwrapRequestId,
        bytes32 encryptedAmount,
        uint64 cleartextAmount
    );

    function name() external pure returns (string memory) { return "Mock cToken"; }
    function symbol() external pure returns (string memory) { return "McT"; }
    function decimals() external pure returns (uint8) { return 6; }
    function underlying() external pure returns (address) { return address(0); }
    function rate() external pure returns (uint256) { return 1e18; }
    function confidentialBalanceOf(address) external pure returns (bytes32) { return bytes32(0); }

    function emitTransfer(address from, address to, bytes32 amount) external {
        emit ConfidentialTransfer(from, to, amount);
    }

    function emitDisclosure(bytes32 encryptedAmount, uint64 amount) external {
        emit AmountDisclosed(encryptedAmount, amount);
    }
}
