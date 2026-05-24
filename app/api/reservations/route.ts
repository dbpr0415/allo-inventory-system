import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DistributedLock, redis } from "@/lib/redis";
import { createReservationSchema } from "@/lib/validations";
import { addMinutes } from "date-fns";

const RESERVATION_TIMEOUT_MINUTES =
  parseInt(process.env.NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES || "10", 10);

/**
 * Handle idempotency for POST requests
 */
async function handleIdempotency(
  idempotencyKey: string,
  requestPath: string
): Promise<NextResponse | null> {
  const existingRequest = await prisma.idempotencyKey.findUnique({
    where: { key: idempotencyKey },
  });

  if (existingRequest) {
    return NextResponse.json(existingRequest.response, {
      status: existingRequest.statusCode,
      headers: {
        "X-Idempotency-Replay": "true",
      },
    });
  }

  return null;
}

/**
 * Store idempotency response
 */
async function storeIdempotencyResponse(
  idempotencyKey: string,
  requestPath: string,
  requestBody: unknown,
  response: unknown,
  statusCode: number
): Promise<void> {
  const expiresAt = addMinutes(new Date(), 60 * 24); // 24 hours

  await prisma.idempotencyKey.create({
    data: {
      key: idempotencyKey,
      requestPath,
      requestBody: requestBody as any,
      response: response as any,
      statusCode,
      expiresAt,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Handle idempotency
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (idempotencyKey) {
      const cachedResponse = await handleIdempotency(
        idempotencyKey,
        "/api/reservations"
      );
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // Validate input
    const validationResult = createReservationSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const { productId, warehouseId, quantity } = validationResult.data;

    // Create lock key for this specific product-warehouse combination
    const lockKey = `reservation:${productId}:${warehouseId}`;

    // Execute reservation logic with distributed lock
    const result = await DistributedLock.withLock(lockKey, async () => {
      // Fetch current stock within transaction
      const stock = await prisma.stock.findUnique({
        where: {
          productId_warehouseId: {
            productId,
            warehouseId,
          },
        },
      });

      if (!stock) {
        return {
          success: false,
          error: "Stock not found for this product-warehouse combination",
          statusCode: 404,
        };
      }

      const availableUnits = stock.totalUnits - stock.reservedUnits;

      if (availableUnits < quantity) {
        return {
          success: false,
          error: "Insufficient stock available",
          statusCode: 409,
          data: {
            requested: quantity,
            available: availableUnits,
          },
        };
      }

      // Create reservation and update stock in a transaction
      const expiresAt = addMinutes(new Date(), RESERVATION_TIMEOUT_MINUTES);

      const [reservation] = await prisma.$transaction([
        prisma.reservation.create({
          data: {
            productId,
            warehouseId,
            quantity,
            expiresAt,
            status: "PENDING",
          },
          include: {
            product: true,
            warehouse: true,
          },
        }),
        prisma.stock.update({
          where: {
            productId_warehouseId: {
              productId,
              warehouseId,
            },
          },
          data: {
            reservedUnits: {
              increment: quantity,
            },
          },
        }),
      ]);

      return {
        success: true,
        data: reservation,
        statusCode: 201,
      };
    });

    if (!result.success) {
      const response = { error: result.error, ...result.data };

      // Store idempotency response for errors too
      if (idempotencyKey) {
        await storeIdempotencyResponse(
          idempotencyKey,
          "/api/reservations",
          body,
          response,
          result.statusCode
        );
      }

      return NextResponse.json(response, { status: result.statusCode });
    }

    const responseData = { reservation: result.data };

    // Store idempotency response
    if (idempotencyKey) {
      await storeIdempotencyResponse(
        idempotencyKey,
        "/api/reservations",
        body,
        responseData,
        result.statusCode
      );
    }

    return NextResponse.json(responseData, { status: result.statusCode });
  } catch (error) {
    console.error("Error creating reservation:", error);

    if (error instanceof Error && error.message === "Failed to acquire lock") {
      return NextResponse.json(
        { error: "System is busy, please try again" },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: "Failed to create reservation" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const reservations = await prisma.reservation.findMany({
      include: {
        product: true,
        warehouse: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(reservations);
  } catch (error) {
    console.error("Error fetching reservations:", error);
    return NextResponse.json(
      { error: "Failed to fetch reservations" },
      { status: 500 }
    );
  }
}
