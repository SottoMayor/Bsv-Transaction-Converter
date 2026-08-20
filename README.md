# bsv-transaction-converter

TypeScript library for converting Bitcoin SV transactions between the RAW, EF, and BEEF formats.

## What is it

BSV transactions can travel in different formats depending on the context in which they are used. This library provides three converters:

| Converter | Input | Output |
|---|---|---|
| `EFPackager` | RAW | EF |
| `BEEFPackager` | RAW | BEEF |
| `BEEFToEFConverter` | BEEF | EF |

The formats are defined by the following specifications:

- **RAW**: standard serialization of a Bitcoin SV transaction.
- **EF (Extended Format, [BRC-30](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0030.md))**: injects the referenced output data (value + locking script) after the `sequence` field of each input. Allows validators to verify the transaction without needing to fetch the parent transactions.
- **BEEF (Background Evaluation Extended Format, [BRC-62](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0062.md))**: packages the child transaction together with its already-mined parent transactions and their respective Merkle proofs (BUMPs). Enables full SPV verification without access to a full node.

## Installation

```bash
npm install bsv-transaction-converter
```

## Quick start

### RAW => EF

```ts
import { EFPackager } from 'bsv-transaction-converter';

const packager = new EFPackager({ network: 'testnet' });

const childRawTx = '0100000001ea3f3d4bb804e791bbc8ae3925d1294987eeddd035383b338295499cd3a92d3e000000000201daffffffff01bc020000000000000301da8700000000';

// Online mode: fetches parent transactions from WhatsOnChain automatically
const ef = await packager.execute(childRawTx);

// Offline mode: injects parent transactions directly
const ef = await packager.execute(childRawTx, {
  '3e2da9d39c499582333b3835d0ddee874929d12539aec8bb91e704b84b3d3fea':
    '01000000012df46c0ff2be99e27df6ea03d5e0bf8e9dbca9b144e89ea38c2563dcb3359380000000000201daffffffff0120030000000000000301da8700000000',
});

console.log(ef);
// '010000000000000000ef01ea3f3d4bb804e791bbc8ae3925d1294987eeddd035383b338295499cd3a92d3e000000000201daffffffff20030000000000000301da8701bc020000000000000301da8700000000'
```

### RAW => BEEF

```ts
import { BEEFPackager, type BEEFParentMap } from 'bsv-transaction-converter';

const packager = new BEEFPackager({
  network: 'testnet',
  arcApiKey: '<api-key>',
});

const childRawTx = '0100000001419cb100c099ca7b78ede618af92bac46187bc55934323d4b43fd3ce2bbd29b7000000000201daffffffff0158020000000000000301da8700000000';

// Online mode: fetches BUMPs from ARC (Taal) and parent transactions from WhatsOnChain
const beef = await packager.execute(childRawTx);

// Offline mode: injects data directly
const parents: BEEFParentMap = {
  'b729bd2bced33fb4d423439355bc8761c4ba92af18e6ed787bca99c000b19c41': {
    rawTx: '0100000001ea3f3d4bb804e791bbc8ae3925d1294987eeddd035383b338295499cd3a92d3e000000000201daffffffff01bc020000000000000301da8700000000',
    merklePath: 'fe9e7b1a00040209004ae387e1b343b26bac7ae20ba10c0ccfc0b93ce6c7157bd78f48ef0ce9c6ed330802419cb100c099ca7b78ede618af92bac46187bc55934323d4b43fd3ce2bbd29b701050070c43912464c02085348b4b1452e733ab465fa49b3dee8ca8074ba42950b2896010300c9d3ecb30f40903c4c99dd5b6525596eac01eea943a30f6d2c1cc0c320aab78a010000e08c880f48f208d00371031fefea30693fb140d21ef40d03d556a83f1fd5f9cb',
  },
};

const beef = await packager.execute(childRawTx, { parents });

console.log(beef);
// '0100beef01fe9e7b1a00040209004ae387e1b343b26bac7ae20ba10c0ccfc0b93ce6c7157bd78f48ef0ce9c6ed330802419cb100c099ca7b78ede618af92bac46187bc55934323d4b43fd3ce2bbd29b701050070c43912464c02085348b4b1452e733ab465fa49b3dee8ca8074ba42950b2896010300c9d3ecb30f40903c4c99dd5b6525596eac01eea943a30f6d2c1cc0c320aab78a010000e08c880f48f208d00371031fefea30693fb140d21ef40d03d556a83f1fd5f9cb020100000001ea3f3d4bb804e791bbc8ae3925d1294987eeddd035383b338295499cd3a92d3e000000000201daffffffff01bc020000000000000301da870000000001000100000001419cb100c099ca7b78ede618af92bac46187bc55934323d4b43fd3ce2bbd29b7000000000201daffffffff0158020000000000000301da870000000000'
```

### BEEF => EF

```ts
import { BEEFToEFConverter } from 'bsv-transaction-converter';

const converter = new BEEFToEFConverter();

// Always offline: all necessary data is already contained in the BEEF envelope
const beefHex = '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000';

const ef = await converter.execute(beefHex);

console.log(ef);
// '010000000000000000ef01ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff3e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac00000000'
```
