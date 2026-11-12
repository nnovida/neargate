import { DEFAULT_GATEWAY_ACCOUNT_ID, DEFAULT_GATEWAY_URL } from '@agentgate/shared';

/**
 * The CLI commands the site shows. They use the npm binary, which runs from any folder once
 * installed; the repository's `npm run neargate -- …` works only from the root of a clone, so the
 * site names that form only where it says so.
 */
export const CLI_INSTALL = 'npm install -g @neargate/cli';

export const LIST_CMD = 'neargate list';

/** A live wrap names the gateway's account as attestor: the gateway attests as that account. */
export const WRAP_CMD = `neargate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" --account alice.testnet --attestor ${DEFAULT_GATEWAY_ACCOUNT_ID} --gateway ${DEFAULT_GATEWAY_URL}`;

/** The schematic form, with placeholders. */
export const WRAP_SHAPE = 'neargate wrap <url> --price 0.5 --name <name> --account <you> --attestor <gateway account> --gateway <url>';
