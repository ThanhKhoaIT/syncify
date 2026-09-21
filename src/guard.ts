import prompts from 'prompts';
import { ShopifyClient } from './client.js';
import { ResolvedConfig } from './config.js';
import { logger } from './logger.js';

const SHOP_IDENTITY_QUERY = `#graphql
  query ShopIdentity {
    shop {
      myshopifyDomain
      plan {
        displayName
      }
    }
  }
`;

interface ShopIdentityResponse {
  shop: {
    myshopifyDomain: string;
    plan: { displayName: string };
  };
}

export interface GuardOptions {
  yes: boolean;
}

/**
 * Runs immediately before any live write to the "to" store. Steps 1-2
 * (domain distinctness, allowedDestinations) already ran in resolveConfig().
 * This adds the live checks that a dotfile/env edit alone can't fake:
 * the destination's actual Shopify-reported domain and plan.
 *
 * The plan check has no bypass flag on purpose — a store on a paid/production
 * plan can never be a write target, regardless of --yes.
 */
export async function assertSafeToWrite(devClient: ShopifyClient, config: ResolvedConfig, opts: GuardOptions): Promise<void> {
  const data = await devClient.query<ShopIdentityResponse>(SHOP_IDENTITY_QUERY);
  const liveDomain = data.shop.myshopifyDomain;
  const planName = data.shop.plan.displayName;

  if (liveDomain !== config.to.store) {
    throw new Error(
      `Destination guard failed: live shop domain "${liveDomain}" does not match configured "to.store" (${config.to.store}). Aborting — no writes were made.`
    );
  }

  const isDevPlan = config.guard.allowedDevPlanNames.some((name) => name.toLowerCase() === planName.toLowerCase());

  if (!isDevPlan) {
    throw new Error(
      `Destination guard failed: "${liveDomain}" is on plan "${planName}", which is not in guard.allowedDevPlanNames. ` +
        'Refusing to write — this looks like it could be a production/paid store. This check cannot be bypassed with --yes or --live.'
    );
  }

  logger.success(`Destination guard passed: ${liveDomain} (plan: ${planName}) is a safe write target.`);

  if (!opts.yes) {
    const response = await prompts({
      type: 'text',
      name: 'confirmation',
      message: `About to WRITE to ${liveDomain} (plan: ${planName}).\nType the store domain to confirm:`,
    });

    if (response.confirmation !== liveDomain) {
      throw new Error('Confirmation did not match destination domain. Aborting — no writes were made.');
    }
  }
}
