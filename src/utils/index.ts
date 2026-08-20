import axios from 'axios';

export type Network = 'testnet' | 'mainnet';

export function defaultWocBaseUrl(network: Network): string {
  return network === 'mainnet'
    ? 'https://api.whatsonchain.com/v1/bsv/main'
    : 'https://api.whatsonchain.com/v1/bsv/test';
}

export function reverseHex(hex: string): string {
  return hex.match(/.{2}/g)?.reverse().join('') || '';
}

export function encodeVarInt(num: number): string {
  if (num < 0xfd) {
    return num.toString(16).padStart(2, '0');
  } else if (num <= 0xffff) {
    const hex = num.toString(16).padStart(4, '0');
    return 'fd' + hex.match(/.{2}/g)!.reverse().join('');
  } else if (num <= 0xffffffff) {
    const hex = num.toString(16).padStart(8, '0');
    return 'fe' + hex.match(/.{2}/g)!.reverse().join('');
  } else {
    const hex = num.toString(16).padStart(16, '0');
    return 'ff' + hex.match(/.{2}/g)!.reverse().join('');
  }
}

export function readVarInt(hex: string, offset: number): { value: number; bytesRead: number } {
  const firstByte = parseInt(hex.substr(offset, 2), 16);
  if (firstByte < 0xfd) {
    return { value: firstByte, bytesRead: 2 };
  } else if (firstByte === 0xfd) {
    const value = parseInt(hex.substr(offset + 2, 4).match(/.{2}/g)!.reverse().join(''), 16);
    return { value, bytesRead: 6 };
  } else if (firstByte === 0xfe) {
    const value = parseInt(hex.substr(offset + 2, 8).match(/.{2}/g)!.reverse().join(''), 16);
    return { value, bytesRead: 10 };
  } else {
    const value = parseInt(hex.substr(offset + 2, 16).match(/.{2}/g)!.reverse().join(''), 16);
    return { value, bytesRead: 18 };
  }
}

export function formatAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response ? `${err.response.status} ${err.response.statusText}` : err.message;
    const body = err.response?.data ? ` — ${JSON.stringify(err.response.data)}` : '';
    return `${status}${body}`;
  }
  return String(err);
}
