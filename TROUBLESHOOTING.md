# Troubleshooting

## Login fails immediately

- Verify `username`, `password`, and `client_id` in adapter settings.
- Ensure the Viessmann developer app has reCAPTCHA disabled.
- Confirm redirect URI is `http://localhost:4200/`.

## Adapter disconnects after running for a while

- Check token refresh logs for repeated 401 responses.
- Confirm local clock is correct (large time drift can break OAuth flows).
- Increase polling intervals to reduce API pressure.

## HTTP 429 rate limit warnings

- Increase the feature polling interval.
- Use `featureFilter` to restrict paths.
- Use `devicelist` to limit processed devices.

## Commands do not execute

- Commands must be written to `.setValue` states (`ack: false`).
- Confirm the corresponding `.uri` state exists.
- For multi-parameter commands, send valid JSON.
