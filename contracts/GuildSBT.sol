// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GuildSBT
 * @notice Non-transferable collective SBT for ModalIn Credit Groups (Kelompok Kredit).
 * Groups of 5-10 UMKMs share a collective reputation that rises and falls together.
 * Tiers: Bronze (0), Silver (1), Gold (2)
 */
contract GuildSBT is Ownable, ReentrancyGuard {
    enum Tier { Bronze, Silver, Gold }

    struct CreditGroup {
        uint256 groupId;
        string name;
        address[] members;
        uint256 collectiveScore;     // 0-1000 scale
        Tier tier;
        uint256 totalGroupLoans;
        uint256 totalGroupRepayments;
        uint256 createdAt;
        uint256 lastUpdated;
        bool isActive;
    }

    uint256 private _nextGroupId;
    mapping(uint256 => CreditGroup) private _groups;
    mapping(address => uint256) public memberToGroup; // member => groupId (0 = no group)
    mapping(address => bool) public authorizedUpdaters;

    uint256 public constant MIN_MEMBERS = 5;
    uint256 public constant MAX_MEMBERS = 10;
    uint256 public constant SILVER_THRESHOLD = 650;
    uint256 public constant GOLD_THRESHOLD = 800;

    event GroupCreated(uint256 indexed groupId, string name, address indexed founder);
    event MemberJoined(uint256 indexed groupId, address indexed member);
    event MemberRemoved(uint256 indexed groupId, address indexed member);
    event GroupScoreUpdated(uint256 indexed groupId, uint256 oldScore, uint256 newScore, Tier tier);
    event UpdaterAuthorized(address indexed updater, bool authorized);

    error AlreadyInGroup(address member);
    error NotInGroup(address member);
    error GroupFull(uint256 groupId);
    error GroupNotActive(uint256 groupId);
    error InvalidGroupSize();
    error NotAuthorized();

    modifier onlyAuthorized() {
        if (!authorizedUpdaters[msg.sender] && msg.sender != owner()) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {
        _nextGroupId = 1;
    }

    /**
     * @notice Creates a new credit group. Founder must not already be in a group.
     */
    function createGroup(string calldata name) external nonReentrant returns (uint256) {
        if (memberToGroup[msg.sender] != 0) revert AlreadyInGroup(msg.sender);

        uint256 groupId = _nextGroupId++;
        address[] memory initialMembers = new address[](1);
        initialMembers[0] = msg.sender;

        _groups[groupId] = CreditGroup({
            groupId: groupId,
            name: name,
            members: initialMembers,
            collectiveScore: 500,
            tier: Tier.Bronze,
            totalGroupLoans: 0,
            totalGroupRepayments: 0,
            createdAt: block.timestamp,
            lastUpdated: block.timestamp,
            isActive: true
        });
        memberToGroup[msg.sender] = groupId;

        emit GroupCreated(groupId, name, msg.sender);
        return groupId;
    }

    /**
     * @notice Join an existing group. Max 10 members.
     */
    function joinGroup(uint256 groupId) external nonReentrant {
        if (memberToGroup[msg.sender] != 0) revert AlreadyInGroup(msg.sender);
        CreditGroup storage group = _groups[groupId];
        if (!group.isActive) revert GroupNotActive(groupId);
        if (group.members.length >= MAX_MEMBERS) revert GroupFull(groupId);

        group.members.push(msg.sender);
        memberToGroup[msg.sender] = groupId;
        group.lastUpdated = block.timestamp;

        emit MemberJoined(groupId, msg.sender);
    }

    /**
     * @notice Updates collective group score. If a member defaults, the whole group is penalized.
     */
    function updateGroupScore(uint256 groupId, uint256 newScore) external onlyAuthorized {
        require(newScore <= 1000, "Score exceeds maximum");
        CreditGroup storage group = _groups[groupId];
        if (!group.isActive) revert GroupNotActive(groupId);

        uint256 oldScore = group.collectiveScore;
        group.collectiveScore = newScore;
        group.tier = _calculateTier(newScore);
        group.lastUpdated = block.timestamp;

        emit GroupScoreUpdated(groupId, oldScore, newScore, group.tier);
    }

    function recordGroupLoan(uint256 groupId) external onlyAuthorized {
        _groups[groupId].totalGroupLoans++;
        _groups[groupId].lastUpdated = block.timestamp;
    }

    function recordGroupRepayment(uint256 groupId) external onlyAuthorized {
        _groups[groupId].totalGroupRepayments++;
        _groups[groupId].lastUpdated = block.timestamp;
    }

    function setAuthorizedUpdater(address updater, bool authorized) external onlyOwner {
        authorizedUpdaters[updater] = authorized;
        emit UpdaterAuthorized(updater, authorized);
    }

    function getGroup(uint256 groupId) external view returns (CreditGroup memory) {
        return _groups[groupId];
    }

    function getGroupByMember(address member) external view returns (CreditGroup memory) {
        uint256 groupId = memberToGroup[member];
        return _groups[groupId];
    }

    function getGroupTier(uint256 groupId) external view returns (Tier) {
        return _groups[groupId].tier;
    }

    function getGroupScore(uint256 groupId) external view returns (uint256) {
        return _groups[groupId].collectiveScore;
    }

    function isGroupMember(address account) external view returns (bool) {
        return memberToGroup[account] != 0;
    }

    function getGroupMembers(uint256 groupId) external view returns (address[] memory) {
        return _groups[groupId].members;
    }

    function _calculateTier(uint256 score) internal pure returns (Tier) {
        if (score >= GOLD_THRESHOLD) return Tier.Gold;
        if (score >= SILVER_THRESHOLD) return Tier.Silver;
        return Tier.Bronze;
    }
}
