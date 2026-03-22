// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./SoulboundToken.sol";
import "./GuildSBT.sol";

/**
 * @title InterestRateModel
 * @notice Algorithmic interest rate model for ModalIn.
 * APR (in basis points) = BaseRate + GroupRiskPremium - ReputationDiscount
 *
 * - BaseRate: minimum rate floor (e.g. 1200 bps = 12% APR)
 * - GroupRiskPremium: added if group tier is Bronze/Silver (penalizes low-trust groups)
 * - ReputationDiscount: subtracted based on individual SBT score (rewards good borrowers)
 *
 * 1 basis point = 0.01%, so 1200 bps = 12% APR
 */
contract InterestRateModel is Ownable {
    SoulboundToken public soulboundToken;
    GuildSBT public guildSBT;

    // All rates in basis points (1 bps = 0.01%)
    uint256 public baseRate = 1200;           // 12% APR floor
    uint256 public bronzeRiskPremium = 800;   // +8% for Bronze tier groups
    uint256 public silverRiskPremium = 400;   // +4% for Silver tier groups
    uint256 public goldRiskPremium = 0;       // +0% for Gold tier groups
    uint256 public maxReputationDiscount = 600; // up to -6% for high reputation
    uint256 public maxAPR = 3600;             // 36% APR cap (OJK regulatory limit reference)
    uint256 public minAPR = 600;              // 6% APR floor

    event RatesUpdated(uint256 baseRate, uint256 maxAPR, uint256 minAPR);
    event PremiumsUpdated(uint256 bronze, uint256 silver, uint256 gold);

    constructor(address _soulboundToken, address _guildSBT) Ownable(msg.sender) {
        soulboundToken = SoulboundToken(_soulboundToken);
        guildSBT = GuildSBT(_guildSBT);
    }

    /**
     * @notice Calculates APR in basis points for a borrower.
     * @param borrower The borrower's address
     * @return apr Annual Percentage Rate in basis points
     */
    function calculateAPR(address borrower) external view returns (uint256 apr) {
        uint256 reputationScore = soulboundToken.getReputationScore(borrower); // 0-1000
        uint256 groupRiskPremium = _getGroupRiskPremium(borrower);
        uint256 reputationDiscount = _getReputationDiscount(reputationScore);

        uint256 rawAPR = baseRate + groupRiskPremium;
        apr = rawAPR > reputationDiscount ? rawAPR - reputationDiscount : minAPR;

        // Clamp to min/max
        if (apr < minAPR) apr = minAPR;
        if (apr > maxAPR) apr = maxAPR;
    }

    /**
     * @notice Calculates the interest amount for a loan.
     * @param borrower The borrower address
     * @param principal Loan amount in wei
     * @param durationDays Loan duration in days
     * @return interest Interest amount in wei
     */
    function calculateInterest(
        address borrower,
        uint256 principal,
        uint256 durationDays
    ) external view returns (uint256 interest) {
        uint256 apr = this.calculateAPR(borrower);
        // interest = principal * APR(bps) * durationDays / (365 * 10000)
        interest = (principal * apr * durationDays) / (365 * 10000);
    }

    /**
     * @notice Returns a breakdown of how the APR was computed.
     */
    function getAPRBreakdown(address borrower) external view returns (
        uint256 base,
        uint256 groupPremium,
        uint256 reputationDiscount,
        uint256 finalAPR
    ) {
        uint256 reputationScore = soulboundToken.getReputationScore(borrower);
        base = baseRate;
        groupPremium = _getGroupRiskPremium(borrower);
        reputationDiscount = _getReputationDiscount(reputationScore);

        uint256 raw = base + groupPremium;
        finalAPR = raw > reputationDiscount ? raw - reputationDiscount : minAPR;
        if (finalAPR < minAPR) finalAPR = minAPR;
        if (finalAPR > maxAPR) finalAPR = maxAPR;
    }

    function _getGroupRiskPremium(address borrower) internal view returns (uint256) {
        uint256 groupId = guildSBT.memberToGroup(borrower);
        if (groupId == 0) return bronzeRiskPremium; // no group = highest risk

        GuildSBT.Tier tier = guildSBT.getGroupTier(groupId);
        if (tier == GuildSBT.Tier.Gold) return goldRiskPremium;
        if (tier == GuildSBT.Tier.Silver) return silverRiskPremium;
        return bronzeRiskPremium;
    }

    function _getReputationDiscount(uint256 score) internal view returns (uint256) {
        // Linear discount: score 1000 = max discount, score 0 = no discount
        return (score * maxReputationDiscount) / 1000;
    }

    function setBaseRate(uint256 _baseRate) external onlyOwner {
        baseRate = _baseRate;
        emit RatesUpdated(_baseRate, maxAPR, minAPR);
    }

    function setAPRBounds(uint256 _minAPR, uint256 _maxAPR) external onlyOwner {
        require(_minAPR < _maxAPR, "Min must be less than max");
        minAPR = _minAPR;
        maxAPR = _maxAPR;
        emit RatesUpdated(baseRate, _maxAPR, _minAPR);
    }

    function setRiskPremiums(uint256 _bronze, uint256 _silver, uint256 _gold) external onlyOwner {
        bronzeRiskPremium = _bronze;
        silverRiskPremium = _silver;
        goldRiskPremium = _gold;
        emit PremiumsUpdated(_bronze, _silver, _gold);
    }

    function setMaxReputationDiscount(uint256 _maxDiscount) external onlyOwner {
        maxReputationDiscount = _maxDiscount;
    }
}
