// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Minimal ACL stub that emits the delegation event our indexer watches.
contract MockAcl {
    event DelegatedForUserDecryption(
        address indexed delegator,
        address indexed delegate,
        address contractAddress,
        uint64 delegationCounter,
        uint64 oldExpirationDate,
        uint64 newExpirationDate
    );

    uint64 private counter;
    mapping(bytes32 delegationKey => uint64 expiry) private expiries;

    function emitDelegation(
        address delegator,
        address delegate,
        address contractAddress,
        uint64 expiry
    ) external {
        bytes32 key = keccak256(abi.encode(delegator, delegate, contractAddress));
        uint64 oldExpiry = expiries[key];
        expiries[key] = expiry;
        counter += 1;
        emit DelegatedForUserDecryption(
            delegator, delegate, contractAddress, counter, oldExpiry, expiry
        );
    }
}
