package com.yyc.driver;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

final class Api {
    static final class Failure extends IOException {
        final int status;
        Failure(int status, String message) { super(message); this.status = status; }
    }
    static String origin(String value) throws Exception {
        URI uri = new URI(value.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !(uri.getPath().isEmpty() || "/".equals(uri.getPath())))
            throw new IOException("Enter the HTTPS workspace origin, without a path, query or credentials.");
        return new URI("https", null, uri.getHost(), uri.getPort(), null, null, null).toString();
    }
    static JSONObject request(String origin, String path, String token, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
        connection.setRequestMethod(body == null ? "GET" : "POST");
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            StringBuilder text = new StringBuilder();
            if (stream != null) try (Reader in = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
                char[] buffer = new char[2048]; int read;
                while ((read = in.read(buffer)) != -1) { text.append(buffer, 0, read); if (text.length() > 65536) throw new IOException("Server response exceeded the size limit."); }
            }
            JSONObject result;
            try { result = new JSONObject(text.toString()); }
            catch (Exception ignored) { throw new Failure(status, "The workspace returned an unreadable response."); }
            if (status < 200 || status >= 300) throw new Failure(status, result.optString("error", "Workspace request failed."));
            return result;
        } finally { connection.disconnect(); }
    }
}
