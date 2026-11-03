// @near-js/transactions serializes actions with Buffer, which browsers do not provide.
import { Buffer } from 'buffer';

const scope = globalThis as { Buffer?: unknown };
if (!scope.Buffer) scope.Buffer = Buffer;
