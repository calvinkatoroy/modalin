// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./SoulboundToken.sol";
import "./GuildSBT.sol";
import "./VouchRegistry.sol";

/**
 * @title ReputationEngine
 * @notice Aggregates three reputation dimensions into a final credit score:
 *   1. On-chain payment history (repayment rate)
 *   2. Group vouching scores from VouchRegistry
 *   3. Off-chain attestation score (submitted by AttestationOracle)
 *
 * Final Score = (paymentWeight * paymentScore + vouchWeight * vouchScore + attestWeight * attestScore) / 100
 * Default weights: 50% payment, 30% vouch, 20% attestation
 */
contract ReputationEngine is Ownable {
    SoulboundToken public soulboundToken;
    GuildSBT public guildSBT;
    VouchRegistry public vouchRegistry;

    // Weights must sum to 100
    uint256 public paymentWeight = 50;
    uint256 public vouchWeight = 30;
    uint256 public attestWeight = 20;

    // Off-chain attestation scores submitted by oracle (e.g., Tokopedia/GoPay data)
    mapping(address => uint256) public attestationScores; // 0-1000
    mapping(address => address) public attestationOracles; // per-address trusted oracle

    address public defaultOracle;

    // Reputation decay: score decays if borrower is inactive for > 180 days
    uint256 public constant DECAY_PERIOD = 180 days;
    uint256 public constant DECAY_RATE = 10; // lose 10 points per decay period

    event ReputationRecalculated(address indexed borrower, uint256 newScore);
    event AttestationScoreUpdated(address indexed borrower, uint256 score, address oracle);
    event WeightsUpdated(uint256 paymentWeight, uint256 vouchWeight, uint256 attestWeight);
    event DefaultOracleSet(address oracle);

    error WeightsMustSumTo100();
    error NotAuthorizedOracle();

    constructor(
        address _soulboundToken,
        address _guildSBT,
        address _vouchRegistry
    ) Ownable(msg.sender) {
        soulboundToken = SoulboundToken(_soulboundToken);
        guildSBT = GuildSBT(_guildSBT);
        vouchRegistry = VouchRegistry(_vouchRegistry);
    }

    /**
     * @notice Recalculates and writes the reputation score for a borrower.
     * Can be called by anyone — it reads on-chain data and writes to SoulboundToken.
     */
    function recalculateScore(address borrower) external returns (uint256) {
        require(soulboundToken.hasSBT(borrower), "Borrower has no SBT");

        uint256 paymentScore = _getPaymentScore(borrower);
        uint256 vouchScore = vouchRegistry.getVouchScore(borrower);
        uint256 attestScore = attestationScores[borrower];

        // Apply decay if inactive
        SoulboundToken.CreditProfile memory profile = soulboundToken.getProfile(borrower);
        uint256 decayPenalty = 0;
        if (block.timestamp > profile.lastUpdated + DECAY_PERIOD) {
            uint256 periodsElapsed = (block.timestamp - profile.lastUpdated) / DECAY_PERIOD;
            decayPenalty = periodsElapsed * DECAY_RATE;
        }

        uint256 rawScore = (paymentWeight * paymentScore + vouchWeight * vouchScore + attestWeight * attestScore) / 100;
        uint256 finalScore = rawScore > decayPenalty ? rawScore - decayPenalty : 0;
        if (finalScore > 1000) finalScore = 1000;

        soulboundToken.updateReputation(borrower, finalScore);

        // If borrower is in a group, update group score
        uint256 groupId = guildSBT.memberToGroup(borrower);
        if (groupId != 0) {
            _updateGroupScore(groupId);
        }

        emit ReputationRecalculated(borrower, finalScore);
        return finalScore;
    }

    /**
     * @notice Submit off-chain attestation score (e.g., from Tokopedia/Shopee/GoPay data).
     * Only callable by the default oracle or a borrower-specific oracle.
     */
    function submitAttestationScore(address borrower, uint256 score) external {
        if (msg.sender != defaultOracle && msg.sender != attestationOracles[borrower]) {
            revert NotAuthorizedOracle();
        }
        require(score <= 1000, "Score exceeds maximum");
        attestationScores[borrower] = score;
        emit AttestationScoreUpdated(borrower, score, msg.sender);
    }

    function setDefaultOracle(address oracle) external onlyOwner {
        defaultOracle = oracle;
        emit DefaultOracleSet(oracle);
    }

    function setWeights(uint256 _paymentWeight, uint256 _vouchWeight, uint256 _attestWeight) external onlyOwner {
        if (_paymentWeight + _vouchWeight + _attestWeight != 100) revert WeightsMustSumTo100();
        paymentWeight = _paymentWeight;
        vouchWeight = _vouchWeight;
        attestWeight = _attestWeight;
        emit WeightsUpdated(_paymentWeight, _vouchWeight, _attestWeight);
    }

    function _getPaymentScore(address borrower) internal view returns (uint256) {
        uint256 repaymentRate = soulboundToken.getRepaymentRate(borrower); // 0-100
        // Scale to 0-1000
        return repaymentRate * 10;
    }

    function _updateGroupScore(uint256 groupId) internal {
        address[] memory members = guildSBT.getGroupMembers(groupId);
        if (members.length == 0) return;

        uint256 totalScore = 0;
        for (uint256 i = 0; i < members.length; i++) {
            totalScore += soulboundToken.getReputationScore(members[i]);
        }
        uint256 avgScore = totalScore / members.length;
        guildSBT.updateGroupScore(groupId, avgScore);
    }

    function getCompositeScore(address borrower) external view returns (
        uint256 paymentScore,
        uint256 vouchScore,
        uint256 attestScore,
        uint256 compositeScore
    ) {
        paymentScore = _getPaymentScore(borrower);
        vouchScore = vouchRegistry.getVouchScore(borrower);
        attestScore = attestationScores[borrower];
        compositeScore = (paymentWeight * paymentScore + vouchWeight * vouchScore + attestWeight * attestScore) / 100;
    }
}
