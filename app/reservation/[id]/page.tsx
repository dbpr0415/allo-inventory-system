"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Clock, CheckCircle2, XCircle, AlertCircle, Package } from "lucide-react";
import { use } from "react";

type Reservation = {
  id: string;
  quantity: number;
  status: "PENDING" | "CONFIRMED" | "RELEASED" | "EXPIRED";
  expiresAt: string;
  createdAt: string;
  product: {
    id: string;
    name: string;
    description: string | null;
    sku: string;
    price: number;
    imageUrl: string | null;
  };
  warehouse: {
    id: string;
    name: string;
    location: string;
  };
};

function useCountdown(targetDateString: string | undefined) {
  const [timeLeft, setTimeLeft] = useState({
    minutes: 0,
    seconds: 0,
    expired: false,
  });

  useEffect(() => {
    const dateStr = targetDateString;
    if (!dateStr) return;

    function calculateTimeLeft() {
      const now = new Date().getTime();
      const target = new Date(dateStr!).getTime();
      const difference = target - now;

      if (difference <= 0) {
        return { minutes: 0, seconds: 0, expired: true };
      }

      const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((difference % (1000 * 60)) / 1000);

      return { minutes, seconds, expired: false };
    }

    setTimeLeft(calculateTimeLeft());

    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft());
    }, 1000);

    return () => clearInterval(timer);
  }, [targetDateString]);

  return timeLeft;
}

export default function ReservationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<"confirm" | "release" | null>(null);

  const countdown = useCountdown(reservation?.expiresAt);

  useEffect(() => {
    fetchReservation();
  }, [resolvedParams.id]);

  useEffect(() => {
    if (countdown.expired && reservation?.status === "PENDING") {
      setError("This reservation has expired");
      setTimeout(() => fetchReservation(), 2000);
    }
  }, [countdown.expired, reservation?.status]);

  async function fetchReservation() {
    try {
      const response = await fetch("/api/reservations");
      if (!response.ok) throw new Error("Failed to fetch reservations");
      const reservations = await response.json();
      const found = reservations.find((r: Reservation) => r.id === resolvedParams.id);

      if (!found) {
        setError("Reservation not found");
      } else {
        setReservation(found);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!reservation) return;

    setActionLoading("confirm");
    setError(null);

    try {
      const idempotencyKey = `confirm-${reservation.id}-${Date.now()}`;

      const response = await fetch(`/api/reservations/${reservation.id}/confirm`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 410) {
          setError("This reservation has expired and cannot be confirmed");
        } else {
          setError(data.error || "Failed to confirm reservation");
        }
        await fetchReservation();
        return;
      }

      setReservation(data.reservation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRelease() {
    if (!reservation) return;

    setActionLoading("release");
    setError(null);

    try {
      const response = await fetch(`/api/reservations/${reservation.id}/release`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to release reservation");
        return;
      }

      setReservation(data.reservation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-slate-600">Loading reservation...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!reservation) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error || "Reservation not found"}</AlertDescription>
        </Alert>
        <Button onClick={() => router.push("/")} className="mt-4">
          Back to Products
        </Button>
      </div>
    );
  }

  const isPending = reservation.status === "PENDING";
  const isConfirmed = reservation.status === "CONFIRMED";
  const isReleased = reservation.status === "RELEASED" || reservation.status === "EXPIRED";

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <Button
        variant="ghost"
        onClick={() => router.push("/")}
        className="mb-6"
      >
        ← Back to Products
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-2xl">Reservation Details</CardTitle>
              <CardDescription className="mt-1">
                ID: {reservation.id.slice(0, 8)}...
              </CardDescription>
            </div>
            <Badge
              variant={
                isConfirmed
                  ? "default"
                  : isReleased
                  ? "secondary"
                  : "outline"
              }
              className={
                isConfirmed
                  ? "bg-green-600"
                  : isReleased
                  ? "bg-slate-600"
                  : "bg-yellow-600 text-white"
              }
            >
              {reservation.status}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {isPending && countdown.expired && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Reservation Expired</AlertTitle>
              <AlertDescription>
                This reservation has expired. The units have been returned to available stock.
              </AlertDescription>
            </Alert>
          )}

          {isPending && !countdown.expired && (
            <Alert>
              <Clock className="h-4 w-4" />
              <AlertTitle>Time Remaining</AlertTitle>
              <AlertDescription>
                <div className="mt-2">
                  <div className="text-3xl font-bold tabular-nums">
                    {countdown.minutes.toString().padStart(2, "0")}:
                    {countdown.seconds.toString().padStart(2, "0")}
                  </div>
                  <p className="text-sm mt-1">
                    Expires at {formatDate(new Date(reservation.expiresAt))}
                  </p>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {isConfirmed && (
            <Alert className="border-green-600 bg-green-50">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertTitle className="text-green-900">Purchase Confirmed</AlertTitle>
              <AlertDescription className="text-green-800">
                Your order has been confirmed and will be processed shortly.
              </AlertDescription>
            </Alert>
          )}

          {isReleased && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertTitle>Reservation Released</AlertTitle>
              <AlertDescription>
                This reservation has been released. The units have been returned to stock.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex gap-4">
            {reservation.product.imageUrl && (
              <div className="w-24 h-24 rounded-lg overflow-hidden bg-slate-100 shrink-0">
                <img
                  src={reservation.product.imageUrl}
                  alt={reservation.product.name}
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <div className="flex-1">
              <h3 className="font-semibold text-lg">{reservation.product.name}</h3>
              <p className="text-sm text-slate-600">SKU: {reservation.product.sku}</p>
              {reservation.product.description && (
                <p className="text-sm text-slate-600 mt-1">
                  {reservation.product.description}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4 border-t">
            <div>
              <p className="text-sm text-slate-600">Quantity</p>
              <p className="font-semibold">{reservation.quantity} unit(s)</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Price per Unit</p>
              <p className="font-semibold">
                {formatCurrency(Number(reservation.product.price))}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Warehouse</p>
              <p className="font-semibold">{reservation.warehouse.name}</p>
              <p className="text-xs text-slate-600">{reservation.warehouse.location}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Total Amount</p>
              <p className="font-semibold text-lg text-blue-600">
                {formatCurrency(Number(reservation.product.price) * reservation.quantity)}
              </p>
            </div>
          </div>

          <div className="pt-4 border-t">
            <p className="text-sm text-slate-600">Reserved At</p>
            <p className="font-medium">{formatDate(new Date(reservation.createdAt))}</p>
          </div>
        </CardContent>

        <CardFooter className="flex gap-3">
          {isPending && !countdown.expired && (
            <>
              <Button
                onClick={handleConfirm}
                disabled={actionLoading !== null}
                className="flex-1 bg-green-600 hover:bg-green-700"
              >
                {actionLoading === "confirm" ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Confirming...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Confirm Purchase
                  </>
                )}
              </Button>
              <Button
                onClick={handleRelease}
                disabled={actionLoading !== null}
                variant="outline"
                className="flex-1"
              >
                {actionLoading === "release" ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-slate-600 mr-2"></div>
                    Canceling...
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4 mr-2" />
                    Cancel
                  </>
                )}
              </Button>
            </>
          )}

          {(isConfirmed || isReleased || countdown.expired) && (
            <Button onClick={() => router.push("/")} className="w-full">
              <Package className="h-4 w-4 mr-2" />
              Browse Products
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
