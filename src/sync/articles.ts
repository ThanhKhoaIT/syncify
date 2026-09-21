import { SyncContext, SyncResult } from '../types.js';
import { logger, createProgressBar } from '../logger.js';

interface Blog {
  handle: string;
  title: string;
}

interface Article {
  handle: string;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  isPublished: boolean;
  author: { name: string } | null;
  blog: { handle: string };
}

const BLOGS_QUERY = `#graphql
  query Blogs($cursor: String) {
    blogs(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle title }
    }
  }
`;

const DEV_BLOGS_QUERY = `#graphql
  query DevBlogs($cursor: String) {
    blogs(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

const ARTICLES_QUERY = `#graphql
  query Articles($cursor: String) {
    articles(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        title
        body
        summary
        tags
        isPublished
        author { name }
        blog { handle }
      }
    }
  }
`;

const DEV_ARTICLES_QUERY = `#graphql
  query DevArticles($cursor: String) {
    articles(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle blog { handle } }
    }
  }
`;

// NOTE: verify BlogCreateInput/ArticleCreateInput/ArticleUpdateInput's exact
// shape via schema introspection for the pinned apiVersion before the first
// live run.
const BLOG_CREATE = `#graphql
  mutation BlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle }
      userErrors { field message }
    }
  }
`;

const ARTICLE_CREATE = `#graphql
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }
`;

const ARTICLE_UPDATE = `#graphql
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }
`;

export async function syncArticles(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [];

  const blogs: Blog[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await ctx.prod.query(BLOGS_QUERY, { cursor });
    blogs.push(...data.blogs.nodes);
    cursor = data.blogs.pageInfo.hasNextPage ? data.blogs.pageInfo.endCursor : null;
  } while (cursor);

  const articles: Article[] = [];
  cursor = null;
  do {
    const data: any = await ctx.prod.query(ARTICLES_QUERY, { cursor });
    articles.push(...data.articles.nodes);
    cursor = data.articles.pageInfo.hasNextPage ? data.articles.pageInfo.endCursor : null;
  } while (cursor);

  logger.step(`Found ${blogs.length} blogs and ${articles.length} articles on ${ctx.config.prodStore}.`);

  const planned = blogs.length + articles.length;

  if (!ctx.live) {
    return {
      resource: 'articles',
      planned,
      applied: 0,
      skipped: 0,
      notes: [...notes, `Dry-run: ${blogs.length} blogs and ${articles.length} articles would be upserted.`],
    };
  }

  // Blogs first — articles need the Dev blog's id. Matched by handle
  // (normalized) so re-running doesn't create duplicates.
  const devBlogIds = new Map<string, string>();
  let devCursor: string | null = null;
  do {
    const data: any = await ctx.dev.query(DEV_BLOGS_QUERY, { cursor: devCursor });
    for (const b of data.blogs.nodes) devBlogIds.set(b.handle.normalize('NFC'), b.id);
    devCursor = data.blogs.pageInfo.hasNextPage ? data.blogs.pageInfo.endCursor : null;
  } while (devCursor);

  let applied = 0;
  const bar = createProgressBar(planned, 'articles');

  for (const blog of blogs) {
    const handle = blog.handle.normalize('NFC');
    if (!devBlogIds.has(handle)) {
      const result: any = await ctx.dev.mutate(BLOG_CREATE, { blog: { title: blog.title, handle } });
      if (result.blogCreate.userErrors?.length) {
        notes.push(`Blog "${handle}": ${JSON.stringify(result.blogCreate.userErrors)}`);
        bar.tick();
        continue;
      }
      devBlogIds.set(handle, result.blogCreate.blog.id);
    }
    applied += 1;
    bar.tick();
  }

  // Existing dev articles, keyed by "blogHandle::articleHandle" since an
  // article's handle is only unique within its own blog.
  const existingArticles = new Map<string, string>();
  devCursor = null;
  do {
    const data: any = await ctx.dev.query(DEV_ARTICLES_QUERY, { cursor: devCursor });
    for (const a of data.articles.nodes) {
      existingArticles.set(`${a.blog.handle.normalize('NFC')}::${a.handle.normalize('NFC')}`, a.id);
    }
    devCursor = data.articles.pageInfo.hasNextPage ? data.articles.pageInfo.endCursor : null;
  } while (devCursor);

  for (const article of articles) {
    const blogHandle = article.blog.handle.normalize('NFC');
    const articleHandle = article.handle.normalize('NFC');
    const devBlogId = devBlogIds.get(blogHandle);

    if (!devBlogId) {
      notes.push(`Article "${articleHandle}": parent blog "${blogHandle}" failed to sync — skipped.`);
      bar.tick();
      continue;
    }

    const input = {
      blogId: devBlogId,
      title: article.title,
      handle: articleHandle,
      body: article.body,
      summary: article.summary,
      tags: article.tags,
      isPublished: article.isPublished,
      author: article.author ? { name: article.author.name } : undefined,
    };

    const key = `${blogHandle}::${articleHandle}`;
    const existingId = existingArticles.get(key);

    const result: any = existingId
      ? await ctx.dev.mutate(ARTICLE_UPDATE, { id: existingId, article: input })
      : await ctx.dev.mutate(ARTICLE_CREATE, { article: input });

    const payload = existingId ? result.articleUpdate : result.articleCreate;
    if (payload.userErrors?.length) {
      notes.push(`Article "${blogHandle}/${articleHandle}": ${JSON.stringify(payload.userErrors)}`);
    } else {
      applied += 1;
    }
    bar.tick();
  }
  bar.done();

  return { resource: 'articles', planned, applied, skipped: planned - applied, notes };
}
