/**
 * Validation for the two settings the user types, kept apart from `config.ts`
 * so it can be exercised without constructing the electron-store - importing
 * that module builds a `Store`, which needs a live Electron app.
 */

/**
 * Checks the *shape* of a region rather than membership in a list. AWS adds
 * regions regularly, and a hardcoded list would start rejecting legitimate
 * ones the moment a new region shipped - the dashboard's dropdown is already
 * the thing that has to be kept current. Matches us-east-1, ap-southeast-4,
 * us-gov-west-1 and cn-north-1 alike.
 */
const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Validates what the dashboard sends before any of it reaches the store or an
 * AWS client constructor. Returns a message to show the user, or null if the
 * settings are usable.
 *
 * Deliberately not restricted to `*.awsapps.com`: IAM Identity Center supports
 * custom access portal domains, and rejecting those would lock out the
 * organisations that use them.
 */
export function validateUserConfig(settings: {
    startUrl?: unknown;
    region?: unknown;
}): string | null {
    const { startUrl, region } = settings;

    if (typeof startUrl !== "string" || !startUrl.trim()) {
        return "Enter your AWS access portal URL.";
    }

    let parsed: URL;
    try {
        parsed = new URL(startUrl.trim());
    } catch {
        return "That start URL isn't a valid URL.";
    }

    if (parsed.protocol !== "https:") {
        return "The start URL has to begin with https://.";
    }
    if (!parsed.hostname) {
        return "The start URL is missing a hostname.";
    }

    if (typeof region !== "string" || !REGION_SHAPE.test(region)) {
        return "Pick an AWS region, for example us-east-1.";
    }

    return null;
}
