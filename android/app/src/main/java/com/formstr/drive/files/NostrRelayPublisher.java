package com.formstr.drive.files;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Minimal publish-only Nostr relay client: connect, send ["EVENT", event],
 * wait for ["OK", id, true, ...], disconnect. No subscription/read support —
 * this is intentionally the smallest thing that can publish a pre-signed
 * event from a background service with no signer available.
 */
public final class NostrRelayPublisher {
    private static final long CONNECT_TIMEOUT_MS = 10_000;
    private static final long OK_TIMEOUT_MS = 15_000;
    private static final int RETRY_ATTEMPTS = 3;
    private static final long RETRY_BACKOFF_MS = 3_000;

    private NostrRelayPublisher() {
    }

    /**
     * Publishes to the relay list, retrying the whole list with backoff.
     * Succeeds as soon as one relay confirms OK=true on any attempt.
     */
    public static boolean publishWithRetry(List<String> relays, @Nullable String eventId, String eventJson) {
        for (int attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
            if (publishToAny(relays, eventId, eventJson)) {
                return true;
            }
            if (attempt < RETRY_ATTEMPTS) {
                try {
                    Thread.sleep(RETRY_BACKOFF_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    /**
     * Publishes to EVERY relay in the list concurrently, on every attempt —
     * not just until the first one ACKs. A single successful relay is enough
     * to make the event globally discoverable in theory, but which relay
     * that ends up being depends entirely on which one this device's network
     * happens to reach fastest (e.g. a phone's carrier network vs. a
     * developer's machine can have completely different per-relay
     * reachability). Trying only the first reachable relay, as this used to
     * do, meant a file uploaded from one device could land on a relay a
     * *different* device querying the same drive never manages to connect
     * to — the event exists, just not anywhere that reader is looking.
     * Fanning out to the whole list every time matches how the web upload
     * path already publishes (DataLayer.publishEvent reports one outcome per
     * relay, not "stop at first success") and maximizes the chance any given
     * reader's relay set overlaps with where this actually landed.
     */
    private static boolean publishToAny(List<String> relays, @Nullable String eventId, String eventJson) {
        if (relays.isEmpty()) {
            return false;
        }

        ExecutorService executor = Executors.newFixedThreadPool(Math.min(relays.size(), 8));
        try {
            List<Future<Boolean>> futures = new ArrayList<>(relays.size());
            for (String relay : relays) {
                futures.add(executor.submit(() -> publishToOne(relay, eventId, eventJson)));
            }

            boolean anySucceeded = false;
            for (Future<Boolean> future : futures) {
                try {
                    // Generous outer bound — publishToOne already bounds itself via
                    // CONNECT_TIMEOUT_MS/OK_TIMEOUT_MS internally, this just protects
                    // against get() blocking forever if a socket callback never fires.
                    if (Boolean.TRUE.equals(future.get(CONNECT_TIMEOUT_MS + OK_TIMEOUT_MS, TimeUnit.MILLISECONDS))) {
                        anySucceeded = true;
                    }
                } catch (Exception e) {
                    // This relay's attempt failed or timed out — keep collecting the rest.
                }
            }
            return anySucceeded;
        } finally {
            executor.shutdown();
        }
    }

    private static boolean publishToOne(String relayUrl, @Nullable String eventId, String eventJson) {
        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(OK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build();

        CountDownLatch latch = new CountDownLatch(1);
        AtomicBoolean success = new AtomicBoolean(false);

        Request request = new Request.Builder().url(relayUrl).build();
        WebSocket socket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                webSocket.send("[\"EVENT\"," + eventJson + "]");
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (isOkForEvent(text, eventId)) {
                    success.set(true);
                    latch.countDown();
                    webSocket.close(1000, null);
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
                latch.countDown();
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                latch.countDown();
            }
        });

        try {
            latch.await(OK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            socket.close(1000, null);
            client.dispatcher().executorService().shutdown();
        }

        return success.get();
    }

    private static boolean isOkForEvent(@Nullable String text, @Nullable String eventId) {
        if (text == null) return false;
        try {
            JSONArray arr = new JSONArray(text);
            if (arr.length() < 3 || !"OK".equals(arr.optString(0))) {
                return false;
            }
            if (eventId != null && !eventId.equals(arr.optString(1))) {
                return false;
            }
            return arr.optBoolean(2, false);
        } catch (JSONException e) {
            return false;
        }
    }

    @Nullable
    public static String extractEventId(String eventJson) {
        try {
            String id = new JSONObject(eventJson).optString("id", null);
            return id == null || id.isEmpty() ? null : id;
        } catch (JSONException e) {
            return null;
        }
    }
}
