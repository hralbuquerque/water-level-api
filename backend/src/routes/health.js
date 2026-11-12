import { Router } from 'express';

const router = Router();

// Liveness check for load balancers and the frontend
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

export default router;
