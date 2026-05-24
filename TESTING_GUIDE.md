# Testing Guide

Comprehensive testing instructions for the Allo Inventory System.

## Quick Test Checklist

Use this checklist during the debrief call:

- [ ] Product listing loads with 6 products
- [ ] Each product shows stock for 3 warehouses
- [ ] "Reserve" button creates reservation
- [ ] Countdown timer counts down from 10:00
- [ ] "Confirm Purchase" marks reservation as CONFIRMED
- [ ] "Cancel" marks reservation as RELEASED
- [ ] Expired reservations show 410 error
- [ ] Out-of-stock items show 409 error
- [ ] Concurrent reservations prevent overselling

## Detailed Test Scenarios

### 1. Happy Path - Complete Purchase Flow

**Steps**:
1. Open http://localhost:3000
2. Find "Wireless Headphones Pro" with stock in "Mumbai Central"
3. Click "Reserve" button
4. Verify you're redirected to `/reservation/{id}`
5. Check countdown timer is running (showing 9:59, 9:58...)
6. Click "Confirm Purchase" button
7. Verify status changes to "CONFIRMED" with green badge
8. Click "Browse Products" button
9. Verify stock decreased by 1 unit

**Expected Result**: ✅ Complete purchase flow works end-to-end

---

### 2. Cancellation Flow

**Steps**:
1. Create a new reservation (repeat steps 1-4 from Happy Path)
2. Click "Cancel" button instead of "Confirm Purchase"
3. Verify status changes to "RELEASED"
4. Go back to products page
5. Verify stock returned to original level

**Expected Result**: ✅ Cancelled reservations return stock

---

### 3. Expiry Flow

**Steps**:
1. Create a new reservation
2. **Wait for countdown to reach 0:00** (or modify `NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES` to 1 for faster testing)
3. Verify "Reservation Expired" error appears
4. Try clicking "Confirm Purchase"
5. Verify you get 410 Gone error: "Reservation has expired"
6. Wait up to 5 minutes for cron job to run (or trigger manually: `curl http://localhost:3000/api/cron/expire-reservations`)
7. Refresh products page
8. Verify stock returned to available

**Expected Result**: ✅ Expired reservations cannot be confirmed and auto-release stock

---

### 4. Out of Stock (409 Conflict)

**Setup**: Find or create a product with 0 available units

**Steps**:
1. Go to products page
2. Find product with "0 available" in any warehouse
3. Click "Reserve" button for that warehouse
4. Verify button is disabled

**Alternative** (simulate race condition):
1. Edit seed script to create product with 1 unit total, 1 unit reserved
2. Try to reserve → Get 409 error

**Expected Result**: ✅ Cannot reserve out-of-stock items

---

### 5. Race Condition Prevention (CRITICAL TEST)

This is the core requirement - testing concurrency control.

**Setup**:
1. Use Prisma Studio or seed script to set a product to exactly 2 units in one warehouse
   ```bash
   npx prisma studio
   # Navigate to Stock table
   # Find a stock record
   # Set totalUnits = 2, reservedUnits = 0
   ```

**Steps**:
1. Open your browser
2. Open the product listing page
3. **Open Developer Tools** (F12) → Network tab
4. Find the product with 2 units
5. **Open a second browser tab** (or incognito window) to the same page
6. In both tabs, prepare to click "Reserve" button
7. **Click "Reserve" in BOTH tabs simultaneously** (within 100ms of each other)

**Expected Result**:
- ✅ **Tab 1**: Successfully creates reservation → redirects to reservation page
- ✅ **Tab 2**: Shows error "Insufficient stock! Only 1 unit(s) available."
  
  (Or vice versa - doesn't matter which tab wins, but exactly one must succeed)

**What This Proves**: Distributed locks prevent overselling even under concurrent load.

---

### 6. Idempotency Testing

**Using cURL**:

```bash
# First request
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-12345" \
  -d '{
    "productId": "PUT_REAL_PRODUCT_ID_HERE",
    "warehouseId": "PUT_REAL_WAREHOUSE_ID_HERE",
    "quantity": 1
  }'

# Second request (same idempotency key)
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-12345" \
  -d '{
    "productId": "SAME_PRODUCT_ID",
    "warehouseId": "SAME_WAREHOUSE_ID",
    "quantity": 1
  }'
```

**Expected Result**:
- First request: Returns 201 Created with reservation object
- Second request: Returns 201 Created with **same reservation object** and header `X-Idempotency-Replay: true`
- Database check: Only ONE reservation created (not two)

**Using Browser DevTools**:
1. Open Network tab
2. Create a reservation
3. Find the POST request to `/api/reservations`
4. Right-click → "Copy as cURL"
5. Run it twice in terminal with same Idempotency-Key header
6. Check responses are identical

---

### 7. Cron Job Testing

**Manual Trigger**:

```bash
# Trigger the cron job manually
curl http://localhost:3000/api/cron/expire-reservations

# Expected response:
{
  "message": "Expired reservations processed successfully",
  "count": 2,
  "reservationIds": ["res_abc", "res_xyz"]
}
```

**Automated Testing**:
1. Create 3 reservations
2. Use Prisma Studio to manually set their `expiresAt` to past date:
   ```
   expiresAt = 2024-01-01T00:00:00Z (any past date)
   ```
3. Trigger cron endpoint
4. Refresh Prisma Studio → verify all 3 are now `status = EXPIRED`
5. Check Stock table → verify `reservedUnits` decreased

---

### 8. Error Handling

**Test 400 Bad Request** (Invalid Input):
```bash
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "",
    "warehouseId": "wh_1",
    "quantity": -5
  }'

# Expected: 400 with Zod validation errors
```

**Test 404 Not Found** (Non-existent Product):
```bash
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "non_existent_id",
    "warehouseId": "wh_1",
    "quantity": 1
  }'

# Expected: 404 "Stock not found for this product-warehouse combination"
```

**Test 410 Gone** (Expired Reservation):
1. Create reservation
2. Manually expire it via Prisma Studio (set status = EXPIRED)
3. Try to confirm it
4. Expected: 410 "Reservation has expired"

---

## Performance Testing

### Load Test (Using Artillery or k6)

**Install k6**:
```bash
# macOS
brew install k6

# Linux
wget https://github.com/grafana/k6/releases/download/v0.45.0/k6-v0.45.0-linux-amd64.tar.gz
tar -xzf k6-v0.45.0-linux-amd64.tar.gz
```

**Create test script** (`load-test.js`):
```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10, // 10 virtual users
  duration: '30s',
};

export default function () {
  const productId = 'PUT_REAL_PRODUCT_ID';
  const warehouseId = 'PUT_REAL_WAREHOUSE_ID';

  const payload = JSON.stringify({
    productId,
    warehouseId,
    quantity: 1,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `test-${__VU}-${__ITER}`,
    },
  };

  const res = http.post('http://localhost:3000/api/reservations', payload, params);

  check(res, {
    'status is 201 or 409': (r) => r.status === 201 || r.status === 409,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
}
```

**Run test**:
```bash
k6 run load-test.js
```

**Expected Results**:
- Most requests should succeed (201)
- Some may get 409 (expected under high contention)
- No 500 errors
- No lock acquisition failures
- Average response time < 500ms

---

## Database Inspection

**Using Prisma Studio**:
```bash
npm run db:studio
```

This opens a web UI at http://localhost:5555 where you can:
- View all reservations and their statuses
- Check stock levels (totalUnits, reservedUnits)
- Manually modify data for testing edge cases
- Inspect idempotency keys

**Using SQL** (if connected to Supabase/Neon):
```sql
-- Check all active reservations
SELECT * FROM "Reservation" 
WHERE status = 'PENDING' 
ORDER BY "expiresAt" ASC;

-- Check stock levels
SELECT 
  p.name,
  w.name as warehouse,
  s."totalUnits",
  s."reservedUnits",
  (s."totalUnits" - s."reservedUnits") as available
FROM "Stock" s
JOIN "Product" p ON s."productId" = p.id
JOIN "Warehouse" w ON s."warehouseId" = w.id;

-- Check idempotency keys
SELECT * FROM "IdempotencyKey" 
ORDER BY "createdAt" DESC 
LIMIT 10;
```

---

## Debugging Tips

### Enable Prisma Query Logging

Edit `.env`:
```env
DEBUG=prisma:query
```

Restart dev server → see all SQL queries in console

### Redis Inspection

```bash
# Install Upstash CLI
npm install -g @upstash/cli

# Or use Redis CLI if running local Redis
redis-cli

# Check active locks
KEYS lock:*

# Check lock value
GET lock:reservation:prod_123:wh_1

# TTL (time to live)
TTL lock:reservation:prod_123:wh_1
```

### Network Tab Analysis

1. Open DevTools → Network tab
2. Filter by "Fetch/XHR"
3. Create reservation
4. Inspect request/response:
   - Check Idempotency-Key header
   - Check X-Idempotency-Replay in response
   - Verify status codes (201, 409, 410)

### Console Logs

Check terminal running `npm run dev` for:
- Prisma query logs (if enabled)
- Error stack traces
- Cron job execution logs

---

## Common Issues & Solutions

### Issue: "Lock acquisition failed"

**Cause**: Redis is down or overloaded  
**Fix**: 
1. Check Upstash dashboard
2. Verify UPSTASH_REDIS_REST_URL and TOKEN in .env
3. Test Redis connection:
   ```typescript
   import { redis } from './lib/redis';
   await redis.ping(); // Should return "PONG"
   ```

### Issue: Race condition test doesn't work

**Cause**: Browsers may batch requests  
**Fix**: Use different approaches:
1. Two separate devices/computers
2. cURL from command line
3. Automated script (k6/Artillery)

### Issue: Cron job not expiring reservations

**Cause**: 
- Cron not running (local dev doesn't auto-run cron)
- VERCEL_CRON_SECRET mismatch

**Fix**:
1. Manually trigger: `curl http://localhost:3000/api/cron/expire-reservations`
2. Check Vercel dashboard (Cron Jobs section) in production

### Issue: Stock not updating after confirm/release

**Cause**: Frontend cache  
**Fix**: Hard refresh (Ctrl+Shift+R) or check database directly via Prisma Studio

---

## Automated Testing (Future)

### Unit Tests (Jest)

```typescript
// lib/redis.test.ts
import { DistributedLock } from './redis';

describe('DistributedLock', () => {
  it('prevents concurrent execution', async () => {
    let counter = 0;
    
    const increment = () => new Promise(resolve => {
      const val = counter;
      setTimeout(() => {
        counter = val + 1;
        resolve(counter);
      }, 50);
    });

    await Promise.all([
      DistributedLock.withLock('test', increment),
      DistributedLock.withLock('test', increment),
    ]);

    expect(counter).toBe(2); // Not 1 (race condition)
  });
});
```

### Integration Tests (Playwright)

```typescript
// tests/reservation.spec.ts
import { test, expect } from '@playwright/test';

test('complete reservation flow', async ({ page }) => {
  await page.goto('/');
  await page.click('button:has-text("Reserve")');
  
  await expect(page).toHaveURL(/\/reservation\/.+/);
  await expect(page.locator('[data-testid="countdown"]')).toBeVisible();
  
  await page.click('button:has-text("Confirm Purchase")');
  await expect(page.locator('text=CONFIRMED')).toBeVisible();
});
```

---

## Test Report Template

After testing, fill this out:

```
=== Allo Inventory System - Test Report ===

Date: _______________
Tester: _______________
Environment: [ ] Local  [ ] Staging  [ ] Production

FUNCTIONALITY TESTS
[ ] Product listing loads
[ ] Reservation creation
[ ] Countdown timer
[ ] Confirm purchase
[ ] Cancel reservation
[ ] Expiry handling
[ ] Cron job execution

CONCURRENCY TESTS
[ ] Race condition prevention (critical)
[ ] Lock acquisition/release
[ ] Idempotency

ERROR HANDLING
[ ] 400 Bad Request
[ ] 409 Conflict (out of stock)
[ ] 410 Gone (expired)
[ ] 503 Service Unavailable (lock failure)

PERFORMANCE
Average API latency: _____ ms
Lock acquisition time: _____ ms
Database query time: _____ ms

ISSUES FOUND
1. _______________________________________
2. _______________________________________
3. _______________________________________

OVERALL ASSESSMENT
[ ] Ready for demo
[ ] Ready for production
[ ] Needs fixes before deployment

NOTES:
_______________________________________
_______________________________________
```

---

**Happy Testing! 🧪**
