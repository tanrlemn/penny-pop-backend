import { handleApplyActions } from '../../src/handlers/applyActionsHandler';
import { makeTraceId } from '../../src/http/trace';
import { API_VERSION } from '../../src/http/version';

export default async function handler(req: any, res: any) {
  let body: any = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      const traceId = makeTraceId();
      res.status(400).json({
        apiVersion: API_VERSION,
        traceId,
        code: 'BAD_REQUEST',
        error: 'Invalid JSON body',
      });
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

