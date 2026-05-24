"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatCurrency } from "@/lib/utils";
import { Package, Warehouse, AlertCircle } from "lucide-react";

type Stock = {
  id: string;
  totalUnits: number;
  reservedUnits: number;
  availableUnits: number;
  warehouse: {
    id: string;
    name: string;
    location: string;
  };
};

type Product = {
  id: string;
  name: string;
  description: string | null;
  sku: string;
  price: number;
  imageUrl: string | null;
  stock: Stock[];
};

export default function Home() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reserving, setReserving] = useState<string | null>(null);

  useEffect(() => {
    fetchProducts();
  }, []);

  async function fetchProducts() {
    try {
      const response = await fetch("/api/products");
      if (!response.ok) throw new Error("Failed to fetch products");
      const data = await response.json();
      setProducts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  async function handleReserve(productId: string, warehouseId: string, availableUnits: number) {
    if (availableUnits === 0) {
      alert("No stock available");
      return;
    }

    const reserveKey = `${productId}-${warehouseId}`;
    setReserving(reserveKey);
    setError(null);

    try {
      const idempotencyKey = `reserve-${Date.now()}-${Math.random()}`;

      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          productId,
          warehouseId,
          quantity: 1,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          setError(
            `Insufficient stock! Only ${data.available || 0} unit(s) available.`
          );
        } else {
          setError(data.error || "Failed to create reservation");
        }
        return;
      }

      router.push(`/reservation/${data.reservation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setReserving(null);
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-slate-600">Loading products...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-slate-900 mb-2">Available Products</h2>
        <p className="text-slate-600">
          Reserve items from our multi-warehouse inventory system
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => (
          <Card key={product.id} className="overflow-hidden">
            {product.imageUrl && (
              <div className="aspect-video w-full overflow-hidden bg-slate-100">
                <img
                  src={product.imageUrl}
                  alt={product.name}
                  className="h-full w-full object-cover"
                />
              </div>
            )}
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <CardTitle className="text-xl">{product.name}</CardTitle>
                  <CardDescription className="mt-1">
                    SKU: {product.sku}
                  </CardDescription>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {formatCurrency(Number(product.price))}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {product.description && (
                <p className="text-sm text-slate-600 mb-4">{product.description}</p>
              )}

              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <Warehouse className="h-4 w-4" />
                  <span>Warehouse Availability</span>
                </div>

                {product.stock.map((stock) => {
                  const isReserving = reserving === `${product.id}-${stock.warehouse.id}`;
                  const hasStock = stock.availableUnits > 0;

                  return (
                    <div
                      key={stock.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-sm text-slate-900">
                          {stock.warehouse.name}
                        </p>
                        <p className="text-xs text-slate-600">
                          {stock.warehouse.location}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-sm font-semibold text-slate-900">
                            {stock.availableUnits}
                          </p>
                          <p className="text-xs text-slate-600">available</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() =>
                            handleReserve(
                              product.id,
                              stock.warehouse.id,
                              stock.availableUnits
                            )
                          }
                          disabled={!hasStock || isReserving}
                        >
                          {isReserving ? (
                            <>
                              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white mr-2"></div>
                              Reserving...
                            </>
                          ) : hasStock ? (
                            "Reserve"
                          ) : (
                            "Out of Stock"
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {products.length === 0 && !loading && (
        <div className="text-center py-12">
          <Package className="h-16 w-16 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-900 mb-2">No products available</h3>
          <p className="text-slate-600">Check back later for new inventory</p>
        </div>
      )}
    </div>
  );
}
