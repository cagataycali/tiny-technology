// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * TinyUSDC — the closed-loop USDC for the self-hosted tiny chain.
 *
 * The x402 payer (lib/x402/payer.ts buildTypedData) signs an EIP-3009
 * TransferWithAuthorization against the token's EIP-712 domain, so this
 * contract MUST verify exactly that shape or every outbound payment dies at
 * the facilitator. Domain name "USDC" / version "2" matches the payer's
 * spec-default fallback (payer.ts:315-316) — a challenge that omits
 * extra.name/extra.version still signs correctly against this token.
 *
 * 6 decimals like real USDC: 1 token unit == 1 micro-USDC ledger unit, so the
 * worker ledger's micro ints map 1:1 with no conversion anywhere.
 *
 * mint() is owner-only: on a chain we own, the deployer key IS the monetary
 * authority — the faucet/gamification service mints against it.
 */
contract TinyUSDC {
    string public constant name = "USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// EIP-3009: authorizer => nonce => used/canceled
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    constructor() {
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "TinyUSDC: not owner");
        _;
    }

    function mint(address to, uint256 value) external onlyOwner {
        require(to != address(0), "TinyUSDC: mint to zero");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "TinyUSDC: zero owner");
        owner = next;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "TinyUSDC: allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    /// EIP-3009 v,r,s form — the shape the x402 exact-evm scheme submits.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    /// EIP-3009 packed-bytes form (r||s||v, 65 bytes) — what viem's
    /// signTypedData returns and some facilitators forward verbatim.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(!authorizationState[authorizer][nonce], "TinyUSDC: auth used");
        bytes32 digest = _digest(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        require(ecrecover(digest, v, r, s) == authorizer && authorizer != address(0), "TinyUSDC: bad signature");
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        require(block.timestamp > validAfter, "TinyUSDC: not yet valid");
        require(block.timestamp < validBefore, "TinyUSDC: expired");
        require(!authorizationState[from][nonce], "TinyUSDC: auth used");
        bytes32 digest = _digest(
            keccak256(
                abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
        require(ecrecover(digest, v, r, s) == from && from != address(0), "TinyUSDC: bad signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "TinyUSDC: transfer to zero");
        uint256 bal = balanceOf[from];
        require(bal >= value, "TinyUSDC: balance");
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _splitSignature(bytes calldata signature) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        require(signature.length == 65, "TinyUSDC: sig length");
        r = bytes32(signature[0:32]);
        s = bytes32(signature[32:64]);
        v = uint8(signature[64]);
    }
}
