import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export type TokenFault = 'nonce' | 'audience' | 'issuer' | 'expired' | 'signature' | undefined;

/** A real HTTP IdP fixture; authorization codes, PKCE, signed ID tokens and JWKS are exercised. */
export async function startOidcProvider() {
  const keys = await generateKeyPair('RS256');
  const wrongKeys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirectUri: string; fault: TokenFault }
  >();
  let nextFault: TokenFault;
  let issuer = '';
  let tokenCalls = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, issuer);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/.well-known/openid-configuration') {
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    } else if (url.pathname === '/jwks') {
      response.end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname === '/authorize') {
      if (
        url.searchParams.get('client_id') !== 'imbox-test' ||
        url.searchParams.get('code_challenge_method') !== 'S256'
      ) {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      const code = randomUUID();
      const redirectUri = url.searchParams.get('redirect_uri')!;
      codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        redirectUri,
        fault: nextFault,
      });
      nextFault = undefined;
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      response.writeHead(302, { location: callback.href }).end();
    } else if (url.pathname === '/token' && request.method === 'POST') {
      tokenCalls++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parameters = new URLSearchParams(Buffer.concat(chunks).toString());
      const code = parameters.get('code')!;
      const auth = codes.get(code);
      codes.delete(code);
      const basic = request.headers.authorization
        ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString().split(':')
        : [];
      const clientId = parameters.get('client_id') ?? basic[0];
      const clientSecret = parameters.get('client_secret') ?? basic[1];
      const challenge = createHash('sha256')
        .update(parameters.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !auth ||
        challenge !== auth.challenge ||
        parameters.get('redirect_uri') !== auth.redirectUri ||
        clientId !== 'imbox-test' ||
        clientSecret !== 'test-client-secret'
      ) {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: auth.fault === 'nonce' ? 'wrong-nonce' : auth.nonce,
        name: 'OIDC Alice',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject('oidc-alice')
        .setIssuer(auth.fault === 'issuer' ? 'https://wrong-issuer.test' : issuer)
        .setAudience(auth.fault === 'audience' ? 'wrong-client' : 'imbox-test')
        .setIssuedAt(now)
        .setExpirationTime(auth.fault === 'expired' ? now - 120 : now + 300)
        .sign(auth.fault === 'signature' ? wrongKeys.privateKey : keys.privateKey);
      response.end(
        JSON.stringify({
          access_token: randomUUID(),
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: idToken,
        }),
      );
    } else {
      response.writeHead(404).end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    failNext(fault: TokenFault) {
      nextFault = fault;
    },
    get tokenCalls() {
      return tokenCalls;
    },
    async callback(redirectUrl: string): Promise<URL> {
      const response = await fetch(redirectUrl, { redirect: 'manual' });
      if (response.status !== 302) throw new Error('Test provider rejected authorization request');
      return new URL(response.headers.get('location')!);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
