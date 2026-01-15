import { handleApplyActions } from '../../src/handlers/applyActionsHandler';

export default async function handler(req: any, res: any) {
  let body: any = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
  }

  const result = await handleApplyActions({
    method: req.method ?? 'GET',
    headers: req.headers ?? {},
    body,
  });

  res.status(result.status).json(result.json);
}

