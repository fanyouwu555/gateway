/**
 * k6 Load Test for AI Gateway
 * SLA: TTFB < 500ms, 100 QPS stable for 1 hour
 *
 * Run: k6 run tests/perf/k6-load-test.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // Ramp up to 50 VUs
    { duration: '5m', target: 100 },  // Ramp up to 100 VUs
    { duration: '30m', target: 100 }, // Steady state at 100 VUs
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'],    // Error rate below 1%
    http_reqs: ['rate>=100'],          // At least 100 RPS
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'gateway-test-key-123';

export default function () {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello, what is 2+2?' }],
    max_tokens: 50,
  });

  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'TTFB under 500ms': (r) => r.timings.waiting < 500,
    'response has choices': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.choices && body.choices.length > 0;
      } catch {
        return false;
      }
    },
  });

  sleep(0.1); // 10 requests per second per VU max
}
