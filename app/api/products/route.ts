import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const products = await prisma.product.findMany({
      include: {
        stock: {
          include: {
            warehouse: true,
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });

    const productsWithAvailability = products.map((product) => ({
      ...product,
      stock: product.stock.map((s) => ({
        ...s,
        availableUnits: Math.max(0, s.totalUnits - s.reservedUnits),
      })),
    }));

    return NextResponse.json(productsWithAvailability);
  } catch (error) {
    console.error("Error fetching products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}
