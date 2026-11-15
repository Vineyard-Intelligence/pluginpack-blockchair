// Blockchair pack — Bitcoin and the six chains built like it, through Blockchair's API, for VINEYARD.
//
// What it adds: the UTXO chains with one keyed source. Keyless sources exist for Bitcoin, Litecoin,
// Bitcoin Cash, Dogecoin, Dash and Zcash, a different vendor each, and none was found for Bitcoin
// SV (surveyed 2026-11-14). Blockchair answers all seven with one API, gives an address's first and
// last use without paging through its history, and looks up 100 addresses in one request — which
// is also what lets it say which of Bitcoin, Bitcoin Cash and Bitcoin SV a legacy `1…` was used on.
//
// KEY MODEL: the analyst's own Blockchair API key, a `secret: true` config value sent as `?key=`
// (Blockchair has no header for it) to api.blockchair.com and nowhere else. Every message the pack
// produces passes through values.ts `redact`, because the key is in every URL. No key is bundled.
//
// NOT VERIFIED AGAINST THE LIVE API: no Blockchair key was available when this was written. Every
// answer the tests use is shaped from Blockchair's API documentation (v2.0.80), except the two
// error answers measured without a usable key. README.md says what to check with a key.
//
// Graph writes are STAGED: nothing reaches the project until the analyst reviews and applies it.
import { definePluginPack } from './sdk';
import type { PluginManifest, VineyardPluginPack } from './sdk';
import { PLATFORMS } from './common';
import { summary } from './summary';
import { history } from './history';
import { transaction } from './transaction';
import { networkCheck } from './network-check';

// The pack's page in the marketplace drawer, in Markdown. Lines in an array rather than one template
// literal, because the Markdown is full of backticks.
const PAGE = [
    "For following money on Bitcoin and the chains built like it — Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash and Zcash's transparent addresses: when an address was first and last used, what it received and spent, the transactions that moved its coins and who was on the other side, and which of these chains a legacy `1…` or `3…` was used on.",
    '',
    '**Needs:** a Blockchair API key from a paid Premium API plan (https://blockchair.com/api/plans). Blockchair allows keyless use only for personal, testing, non-commercial and academic work, and asks every commercial project for a key at any volume. Use your own key.',
    '',
    "**Cost:** requests use points from the key's daily quota (10.9 for 100 addresses, 1.9 for ten transactions); each run's summary gives the total.",
    '',
    '**Who sees it:** Blockchair receives every address and transaction looked up, with your key. No one else is contacted.',
    '',
    '**Read results with care:**',
    '',
    '- Balances and dates are confirmed only. Explorers count some early outputs differently, so another may show a different balance.',
    '- History from before a chain split (Bitcoin Cash in 2017, Bitcoin SV in 2018) appears on both sides of it: one string, separate accounts.',
    '- A busy transaction shows its largest counterparties first; the rest are counted, not drawn.',
    '- Shielded Zcash transfers cannot be followed.',
    '',
    "**Data:** Blockchair's, under its terms of service (https://blockchair.com/terms).",
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-blockchair (Apache-2.0)',
].join('\n');

const pack: VineyardPluginPack & {
    author: { name: string; url: string };
    license: string;
    icon: string;
    platforms: PluginManifest['platforms'];
} = {
    identifier: 'run.vineyard.pluginpacks.blockchair',
    content_type: 'vineyard:pluginpack',
    name: 'Blockchair',
    version: '1.0.0',
    summary:
        'Blockchair lookups for Bitcoin, Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash and Zcash: first and last use, balances, transactions with their inputs and outputs, and which chains an address was used on. Needs a Blockchair API key.',
    description: PAGE,
    author: { name: 'VINEYARD', url: 'https://vineyard.run' },
    license: 'Apache-2.0',
    icon: 'blocks',
    platforms: PLATFORMS,
    plugins: [summary, history, transaction, networkCheck],
};

export const blockchairPack = definePluginPack(pack);
export default blockchairPack;
