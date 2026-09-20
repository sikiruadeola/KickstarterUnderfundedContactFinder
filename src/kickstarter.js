/**
 * kickstarter.js
 *
 * Everything that talks to Kickstarter lives here.
 *
 * Real testing today established two separate facts worth writing down,
 * since together they explain this whole file.
 *
 * One, the very first check Kickstarter's Cloudflare shows a visitor clears
 * itself automatically the moment a real, JavaScript capable browser sits
 * on the page for a short while, no click needed at all. A plain HTTP
 * request can never do this, since it cannot run the challenge's own script,
 * which is exactly why every earlier attempt with gotScraping, however
 * clean the proxy address, was rejected outright with the same challenge
 * page every single time.
 *
 * Two, a second, tougher check only ever showed up after one single browser
 * session had already made a lot of requests in a row. That second one did
 * need an actual person.
 *
 * Put together, the fix is a browser that is thrown away after doing one
 * single thing, a fresh address and a fresh, empty browser for every single
 * page, so no session ever lives long enough to earn that second, harder
 * check in the first place.
 */

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { log } from 'crawlee';

const DISCOVER_ROOT = 'https://www.kickstarter.com/discover/advanced';

function looksLikeChallenge(title) {
    return /just a moment|checking your browser|attention required/i.test(title || '');
}

/**
 * Opens one brand new browser on one brand new residential address, waits
 * out the automatic check if one shows up, hands the live page to the
 * caller, then closes everything down. Nothing here is reused between
 * calls, that is the entire point.
 */
async function withDisposablePage(url, proxyConfiguration, handler) {
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    let parsedProxy;
    if (proxyUrl) {
        const p = new URL(proxyUrl);
        parsedProxy = {
            server: `${p.protocol}//${p.hostname}:${p.port}`,
            username: p.username,
            password: p.password,
        };
    }

    const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
    try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            proxy: parsedProxy,
        });
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
            if (!window.chrome) window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });
        const page = await context.newPage();

        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);

        let title = await page.title().catch(() => '');
        if (looksLikeChallenge(title)) {
            const started = Date.now();
            while (Date.now() - started < 150000) {
                await new Promise((r) => setTimeout(r, 2000));
                title = await page.title().catch(() => '');
                if (!looksLikeChallenge(title)) break;
            }
        }

        if (looksLikeChallenge(title)) {
            throw new Error('Challenge did not clear on its own within ninety seconds on a fresh browser.');
        }

        return await handler(page, response);
    } finally {
        await browser.close().catch(() => undefined);
    }
}

/**
 * Walks one category, one state, page by page, stopping on the first empty
 * page, the first real error, or the two hundred page ceiling Kickstarter
 * itself enforces, whichever comes first. Every page gets its own fresh,
 * disposable browser.
 */
export async function discoverProjects({ categoryId, state, sort = 'newest', maxPages = 200, proxyConfiguration }) {
    const projects = [];

    for (let page = 1; page <= maxPages; page += 1) {
        const url = `${DISCOVER_ROOT}?format=json&category_id=${categoryId}&state=${state}&sort=${sort}&page=${page}`;

        let body;
        try {
            body = await withDisposablePage(url, proxyConfiguration, async (p) => {
                const text = await p.evaluate(() => document.body.innerText);
                return JSON.parse(text);
            });
        } catch (error) {
            log.warning(`Discovery page ${page} for state ${state} failed: ${error.message}. Stopping this state here.`);
            break;
        }

        const pageProjects = body?.projects || [];
        if (pageProjects.length === 0) {
            log.info(`State ${state}, page ${page} came back empty. Reached the end of this slice.`);
            break;
        }

        projects.push(...pageProjects);
    }

    return projects;
}

/**
 * Reads a single project's own public page, its own fresh disposable
 * browser too. Returns the full story text and every outbound link found
 * anywhere on the page that does not point back at kickstarter.com itself.
 */
export async function fetchProjectPage(projectUrl, proxyConfiguration) {
    try {
        return await withDisposablePage(projectUrl, proxyConfiguration, async (p) => {
            const html = await p.content();
            const $ = cheerio.load(html);

            const storyText = $('body').text().replace(/\s+/g, ' ').slice(0, 200000);

            const links = new Set();
            $('a[href^="http"]').each((_, el) => {
                const href = $(el).attr('href');
                if (href) links.add(href);
            });

            return { storyText, links: cleanLinks([...links]) };
        });
    } catch (error) {
        log.warning(`Could not read project page ${projectUrl}: ${error.message}`);
        return { storyText: '', links: [] };
    }
}

function cleanLinks(urls) {
    const skipHosts = [
        'kickstarter.com', 'ksr-ugc.imgix.net', 'facebook.com', 'twitter.com', 'x.com',
        'instagram.com', 'google.com', 'gstatic.com', 'googleapis.com', 'apple.com',
        'play.google.com', 'youtube.com', 'youtu.be', 'schema.org', 'w3.org',
        'trustarc.com', 'privacy-mgmt.com', 'sift.com', 'qualtrics.com',
    ];

    const out = new Map();

    for (const raw of urls) {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            continue;
        }

        const host = parsed.hostname.replace(/^www\./, '');
        if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;

        parsed.hash = '';
        for (const p of [...parsed.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|ref$)/i.test(p)) parsed.searchParams.delete(p);
        }

        const key = `${host}${parsed.pathname}`;
        if (!out.has(key)) out.set(key, parsed.toString());
    }

    return [...out.values()];
}

export function splitLinks(urls) {
    const socialHosts = [
        'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com',
        'linkedin.com', 'threads.net', 'reddit.com', 'discord.gg', 'discord.com',
        'patreon.com', 'twitch.tv', 'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co',
        'substack.com', 'medium.com', 'github.com', 'pinterest.com', 'vimeo.com',
    ];

    const ownSites = [];
    const socialProfiles = [];

    for (const url of urls) {
        let host;
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            continue;
        }

        const isAggregator = ['linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co'].some(
            (h) => host === h || host.endsWith(`.${h}`),
        );

        if (isAggregator) {
            ownSites.push(url);
        } else if (socialHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
            socialProfiles.push(url);
        } else {
            ownSites.push(url);
        }
    }

    return { ownSites, socialProfiles };
}
