import { json } from './utils';

export interface ReadingSourceArticle {
  hash: string;
  theme: string;
  title: string;
  title_fr: string | null;
  source_name: string;
  url: string | null;
  summary_fr: string | null;
  published_at: number | null;
}

const BNE_FEED_URL = 'https://breakingnewsenglish.com/bne.xml';
const ELLLO_LATEST_URL = 'https://www.elllo.org/lesson/';

const VOA_CURATED_SOURCES: ReadonlyArray<Omit<ReadingSourceArticle, 'hash'>> = [
  {
    theme: 'tech',
    title: 'VOA Learning English - Science & Technology',
    title_fr: null,
    source_name: 'VOA Learning English',
    url: 'https://learningenglish.voanews.com/p/5610.html',
    summary_fr: 'Intermediate English reading and listening on science and technology, with slower audio and learner-friendly language.',
    published_at: null,
  },
  {
    theme: 'general',
    title: 'VOA Learning English Podcast',
    title_fr: null,
    source_name: 'VOA Learning English',
    url: 'https://learningenglish.voanews.com/podcasts',
    summary_fr: 'Slower English podcast with current topics, ideal for linking reading, listening and comprehension.',
    published_at: null,
  },
  {
    theme: 'grammar',
    title: 'VOA Learning English - Everyday Grammar',
    title_fr: null,
    source_name: 'VOA Learning English',
    url: 'https://learningenglish.voanews.com/p/9415.html',
    summary_fr: 'Grammar and usage lessons in context, written for learners and useful for targeted review.',
    published_at: null,
  },
] as const;

const BRITISH_COUNCIL_CURATED_SOURCES: ReadonlyArray<Omit<ReadingSourceArticle, 'hash'>> = [
  {
    theme: 'general',
    title: 'British Council - A2 Reading Practice',
    title_fr: null,
    source_name: 'British Council LearnEnglish',
    url: 'https://learnenglish.britishcouncil.org/free-resources/reading/a2',
    summary_fr: 'Short graded reading tasks with comprehension activities for everyday English.',
    published_at: null,
  },
  {
    theme: 'general',
    title: 'British Council - B1 Reading Practice',
    title_fr: null,
    source_name: 'British Council LearnEnglish',
    url: 'https://learnenglish.britishcouncil.org/free-resources/reading/b1',
    summary_fr: 'Intermediate reading practice with texts and comprehension tasks arranged by CEFR level.',
    published_at: null,
  },
  {
    theme: 'story',
    title: 'British Council - A2-B1 Story Zone',
    title_fr: null,
    source_name: 'British Council LearnEnglish',
    url: 'https://learnenglish.britishcouncil.org/general-english/story-zone/a2-b1-stories',
    summary_fr: 'Short stories specially written for learners, with reading fluency and comprehension exercises.',
    published_at: null,
  },
] as const;

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string): string {
  return decodeXml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function stableHash(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(index);
    hash |= 0;
  }
  return `src_${Math.abs(hash)}`;
}

function inferTheme(title: string, sourceName: string): string {
  const lower = `${title} ${sourceName}`.toLowerCase();
  if (/grammar|verb|tense|preposition|passive|modal/.test(lower)) return 'grammar';
  if (/conversation|dialogue|speaking|interview|date|people|street/.test(lower)) return 'conversation';
  if (/science|tech|digital|robot|ai|phone|computer/.test(lower)) return 'tech';
  if (/health|lifestyle|food|travel/.test(lower)) return 'lifestyle';
  if (/story|reading|novel/.test(lower)) return 'story';
  return 'general';
}

async function fetchBreakingNewsEnglish(limit: number): Promise<ReadingSourceArticle[]> {
  try {
    const response = await fetch(BNE_FEED_URL, {
      headers: { 'User-Agent': 'EnglishFluency/1.0' },
    });
    if (!response.ok) {
      return [];
    }

    const xml = await response.text();
    const items = xml.split('<item>').slice(1).map((item) => item.split('</item>')[0] ?? '');

    return items.slice(0, limit).map((item) => {
      const title = extractTag(item, 'title');
      const url = extractTag(item, 'link');
      const description = extractTag(item, 'description');
      const publishedAt = Date.parse(extractTag(item, 'pubDate'));

      return {
        hash: stableHash(url || title),
        theme: inferTheme(title, 'Breaking News English'),
        title,
        title_fr: null,
        source_name: 'Breaking News English',
        url: url || null,
        summary_fr: description || title,
        published_at: Number.isNaN(publishedAt) ? null : publishedAt,
      } satisfies ReadingSourceArticle;
    });
  } catch {
    return [];
  }
}

async function fetchEllloLessons(limit: number): Promise<ReadingSourceArticle[]> {
  try {
    const response = await fetch(ELLLO_LATEST_URL, {
      headers: { 'User-Agent': 'EnglishFluency/1.0' },
    });
    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const regex = /<a[^>]+href="([^"]+\.html)"[^>]*>\s*([^<]{4,120})\s*<\/a>/gi;
    const articles: ReadingSourceArticle[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) && articles.length < limit) {
      const href = match[1]?.trim();
      const title = stripHtml(match[2] ?? '');
      if (!href || !title || seen.has(href)) {
        continue;
      }

      const nearby = html.slice(match.index, match.index + 260);
      const levelMatch = nearby.match(/\|\s*(A1|A2|B1|B2|C1)\b/i);
      if (!levelMatch) {
        continue;
      }

      seen.add(href);
      const absoluteUrl = href.startsWith('http') ? href : `https://www.elllo.org${href.startsWith('/') ? '' : '/'}${href}`;
      const level = levelMatch[1].toUpperCase();

      articles.push({
        hash: stableHash(absoluteUrl),
        theme: 'conversation',
        title,
        title_fr: null,
        source_name: 'ELLLO',
        url: absoluteUrl,
        summary_fr: `Natural English conversation with transcript and quiz. Suggested level: ${level}.`,
        published_at: null,
      });
    }

    return articles;
  } catch {
    return [];
  }
}

function buildCuratedSources(
  sources: ReadonlyArray<Omit<ReadingSourceArticle, 'hash'>>,
  limit: number,
): ReadingSourceArticle[] {
  return sources.slice(0, limit).map((source) => ({
    ...source,
    hash: stableHash(source.url || source.title),
  }));
}

export async function fetchReadingSourceArticles(limit = 15): Promise<ReadingSourceArticle[]> {
  const dynamicLimit = Math.max(4, Math.ceil(limit / 3));

  const [bneArticles, ellloArticles] = await Promise.all([
    fetchBreakingNewsEnglish(dynamicLimit),
    fetchEllloLessons(dynamicLimit),
  ]);

  const voaArticles = buildCuratedSources(VOA_CURATED_SOURCES, 3);
  const britishCouncilArticles = buildCuratedSources(BRITISH_COUNCIL_CURATED_SOURCES, 3);

  return [...bneArticles, ...ellloArticles, ...voaArticles, ...britishCouncilArticles]
    .filter((article, index, collection) => collection.findIndex((item) => item.hash === article.hash) === index)
    .sort((left, right) => (right.published_at ?? 0) - (left.published_at ?? 0))
    .slice(0, limit);
}

export async function handleGetReadingSources(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '15'), 30);
  const articles = await fetchReadingSourceArticles(limit);
  return json({ articles });
}
