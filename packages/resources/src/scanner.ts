export interface ScanResult {
  approved: boolean;
  engine: string;
  version: string;
  reason?: string;
}
export type ContentScanner = (bytes: Uint8Array, contentType: string) => Promise<ScanResult>;
export const supportedTextTypes = ['text/plain', 'text/markdown', 'application/json'] as const;
/** A restricted text admission policy, not an antivirus claim for arbitrary binary files. */
export const scanRestrictedText: ContentScanner = async (bytes, contentType) => {
  const reject = (reason: string): ScanResult => ({
    approved: false,
    engine: 'restricted-text-policy',
    version: '1',
    reason,
  });
  if (!(supportedTextTypes as readonly string[]).includes(contentType))
    return reject('unsupported_content_type');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return reject('invalid_utf8');
  }
  if (
    [...text].some((char) => {
      const value = char.charCodeAt(0);
      return (value < 32 && ![9, 10, 13].includes(value)) || value === 127;
    })
  )
    return reject('control_bytes');
  if (text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) return reject('test_signature');
  if (contentType === 'application/json')
    try {
      JSON.parse(text);
    } catch {
      return reject('invalid_json');
    }
  return { approved: true, engine: 'restricted-text-policy', version: '1' };
};
