import { handleOverview } from '../src/handlers/overviewHandler';

export default async function handler(req: any, res: any) {
  const result = await handleOverview({
    method: req.method ?? 'GET',
    headers: req.headers ?? {},
    query: req.query ?? {},
  });

  res.status(result.status).json(result.json);
}
