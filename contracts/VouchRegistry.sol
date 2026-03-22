// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title VouchRegistry
 * @notice Peer vouching system where group members stake ETH as social collateral.
 * If a borrower defaults, vouchers lose their staked ETH — creating organic peer accountability.
 * Vouch score is the weighted average of ETH staked by vouchers (more stake = stronger signal).
 */
contract VouchRegistry is Ownable, ReentrancyGuard {
    struct Vouch {
        address voucher;
        address borrower;
        uint256 stakeAmount;     // ETH staked as collateral
        uint256 vouchScore;      // 0-1000: voucher's own reputation score at time of vouching
        uint256 timestamp;
        bool isActive;
        bool slashed;
    }

    mapping(address => Vouch[]) public vouchesFor;       // borrower => vouches
    mapping(address => Vouch[]) public vouchesBy;        // voucher => vouches given
    mapping(address => mapping(address => uint256)) public vouchIndex; // borrower => voucher => index+1

    uint256 public constant MIN_VOUCH_STAKE = 0.001 ether;
    uint256 public constant MAX_VOUCH_SCORE = 1000;

    address public loanEscrow; // authorized to slash vouchers on default

    event VouchCreated(address indexed voucher, address indexed borrower, uint256 stake);
    event VouchRevoked(address indexed voucher, address indexed borrower, uint256 refund);
    event VoucherSlashed(address indexed voucher, address indexed borrower, uint256 amount);
    event LoanEscrowSet(address indexed escrow);

    error AlreadyVouching(address voucher, address borrower);
    error NotVouching(address voucher, address borrower);
    error InsufficientStake();
    error NotAuthorized();
    error CannotVouchForSelf();

    modifier onlyLoanEscrow() {
        if (msg.sender != loanEscrow && msg.sender != owner()) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Vouch for a borrower by staking ETH. Stake is held until revoked or borrower defaults.
     */
    function vouch(address borrower, uint256 voucherScore) external payable nonReentrant {
        if (msg.sender == borrower) revert CannotVouchForSelf();
        if (msg.value < MIN_VOUCH_STAKE) revert InsufficientStake();
        if (vouchIndex[borrower][msg.sender] != 0) revert AlreadyVouching(msg.sender, borrower);

        Vouch memory newVouch = Vouch({
            voucher: msg.sender,
            borrower: borrower,
            stakeAmount: msg.value,
            vouchScore: voucherScore > MAX_VOUCH_SCORE ? MAX_VOUCH_SCORE : voucherScore,
            timestamp: block.timestamp,
            isActive: true,
            slashed: false
        });

        vouchesFor[borrower].push(newVouch);
        vouchesBy[msg.sender].push(newVouch);
        vouchIndex[borrower][msg.sender] = vouchesFor[borrower].length; // 1-indexed

        emit VouchCreated(msg.sender, borrower, msg.value);
    }

    /**
     * @notice Revoke vouch and reclaim staked ETH. Only possible if borrower hasn't defaulted.
     */
    function revokeVouch(address borrower) external nonReentrant {
        uint256 idx = vouchIndex[borrower][msg.sender];
        if (idx == 0) revert NotVouching(msg.sender, borrower);

        Vouch storage v = vouchesFor[borrower][idx - 1];
        require(v.isActive && !v.slashed, "Vouch not active or already slashed");

        uint256 refund = v.stakeAmount;
        v.isActive = false;
        v.stakeAmount = 0;
        vouchIndex[borrower][msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: refund}("");
        require(success, "Refund failed");

        emit VouchRevoked(msg.sender, borrower, refund);
    }

    /**
     * @notice Slashes all active vouchers for a defaulting borrower. Called by LoanEscrow.
     */
    function slashVouchers(address borrower) external onlyLoanEscrow nonReentrant {
        Vouch[] storage vouches = vouchesFor[borrower];
        for (uint256 i = 0; i < vouches.length; i++) {
            if (vouches[i].isActive && !vouches[i].slashed) {
                uint256 slashedAmount = vouches[i].stakeAmount;
                vouches[i].slashed = true;
                vouches[i].isActive = false;
                vouches[i].stakeAmount = 0;
                // Slashed ETH stays in contract (can be distributed to lenders or burned)
                emit VoucherSlashed(vouches[i].voucher, borrower, slashedAmount);
            }
        }
    }

    /**
     * @notice Returns vouch score for a borrower (weighted avg of vouchers' scores, stake-weighted).
     */
    function getVouchScore(address borrower) external view returns (uint256) {
        Vouch[] storage vouches = vouchesFor[borrower];
        if (vouches.length == 0) return 0;

        uint256 totalWeightedScore = 0;
        uint256 totalStake = 0;

        for (uint256 i = 0; i < vouches.length; i++) {
            if (vouches[i].isActive) {
                totalWeightedScore += vouches[i].vouchScore * vouches[i].stakeAmount;
                totalStake += vouches[i].stakeAmount;
            }
        }

        if (totalStake == 0) return 0;
        return totalWeightedScore / totalStake;
    }

    function getActiveVouchCount(address borrower) external view returns (uint256 count) {
        Vouch[] storage vouches = vouchesFor[borrower];
        for (uint256 i = 0; i < vouches.length; i++) {
            if (vouches[i].isActive) count++;
        }
    }

    function setLoanEscrow(address escrow) external onlyOwner {
        loanEscrow = escrow;
        emit LoanEscrowSet(escrow);
    }

    // Allow owner to withdraw slashed ETH
    function withdrawSlashedFunds(address payable recipient, uint256 amount) external onlyOwner {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "Withdrawal failed");
    }
}
