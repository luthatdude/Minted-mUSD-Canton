/**
 * AWS KMS DER-to-RSV Signature Utility
 * Addresses: T-01 (DER buffer overflow), T-02 (Input validation)
 */
/// <reference types="node" />
/**
 * Validates and parses a DER-encoded ECDSA signature from AWS KMS
 * and converts it to Ethereum's RSV format.
 *
 * @param derSig - DER-encoded signature buffer from AWS KMS
 * @param messageHash - The hash of the message that was signed (0x prefixed hex string)
 * @param publicKey - The expected signer's Ethereum address (0x prefixed)
 * @returns The signature in RSV format (0x prefixed, 65 bytes)
 * @throws Error if signature parsing fails or recovery fails
 */
export declare function formatKMSSignature(derSig: Buffer, messageHash: string, publicKey: string): string;
/**
 * Validates that a signature matches the expected signer
 *
 * @param signature - RSV signature (0x prefixed)
 * @param messageHash - Message hash that was signed
 * @param expectedSigner - Expected signer address
 * @returns true if signature is valid for the expected signer
 */
export declare function validateSignature(signature: string, messageHash: string, expectedSigner: string): boolean;
/**
 * Sorts signatures by recovered signer address for smart contract verification
 *
 * @param signatures - Array of RSV signatures
 * @param messageHash - Message hash that was signed
 * @returns Signatures sorted by recovered signer address (ascending)
 */
export declare function sortSignaturesBySignerAddress(signatures: string[], messageHash: string): string[];
//# sourceMappingURL=signer.d.ts.map