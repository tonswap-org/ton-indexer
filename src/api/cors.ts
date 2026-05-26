import type { Config } from '../config';

type CorsRequest = {
  headers: {
    origin?: string;
  };
};

type CorsReply = {
  header(name: string, value: string | number): unknown;
};

export const setCorsHeaders = (request: CorsRequest, reply: CorsReply, config: Config) => {
  const origin = request.headers.origin;
  const configuredOrigin = config.corsAllowOrigin.trim();
  const exactOrigins = config.corsAllowOrigins;
  let allowOrigin: string | null = null;
  let allowCredentials = false;

  if (origin && exactOrigins.length > 0) {
    if (exactOrigins.includes(origin)) {
      allowOrigin = origin;
      allowCredentials = true;
    }
  } else if (configuredOrigin === '*' || configuredOrigin === 'reflect') {
    allowOrigin = '*';
  } else if (origin && origin === configuredOrigin) {
    allowOrigin = origin;
    allowCredentials = true;
  } else if (!origin && configuredOrigin !== '') {
    allowOrigin = configuredOrigin === 'reflect' ? '*' : configuredOrigin;
    allowCredentials = allowOrigin !== '*';
  }

  if (allowOrigin) {
    reply.header('access-control-allow-origin', allowOrigin);
    if (allowOrigin !== '*') {
      reply.header('vary', 'origin');
    }
    if (allowCredentials) {
      reply.header('access-control-allow-credentials', 'true');
    }
  }
  reply.header('access-control-allow-methods', config.corsAllowMethods);
  reply.header('access-control-allow-headers', config.corsAllowHeaders);
  reply.header('access-control-expose-headers', config.corsExposeHeaders);
  reply.header('access-control-max-age', config.corsMaxAge);
};
