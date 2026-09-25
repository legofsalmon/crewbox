package com.colmhewson.crewbox;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.CameraState;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The camera, full screen, until it reads a QR code with text in it: "Scan
 * the join poster" on the join screen, through {@link ScannerPlugin}.
 *
 * CameraX shows the picture and hands frames to {@link QrFrameReader}, which
 * is ZXing and reads on the phone. ML Kit would read them too, and was the
 * plan, but it reports its use to Google (the phone's model, the app, an
 * identifier per install, timings) with no way to turn that off, and crewbox
 * tells crew that nothing leaves their phone except for their box.
 *
 * Finishes with the text, or with why there is none: backed out of, the
 * camera not allowed or not there, or the camera failing.
 */
public class ScannerActivity extends AppCompatActivity {

  static final String EXTRA_TEXT = "text";
  /** The camera isn't allowed for the app. */
  static final int RESULT_DENIED = RESULT_FIRST_USER;
  /** No camera this can use: none at all, or one switched off by policy. */
  static final int RESULT_UNAVAILABLE = RESULT_FIRST_USER + 1;
  /** The camera wouldn't start, or stopped. */
  static final int RESULT_FAILED = RESULT_FIRST_USER + 2;

  /** Over the picture, behind the words: they have to read over anything. */
  private static final int SCRIM = 0xB3000000;

  private final AtomicBoolean done = new AtomicBoolean(false);
  private ExecutorService frames;
  private PreviewView picture;
  private Button torch;
  private Camera camera;
  private boolean torchOn;
  /** Reused for every frame: the analyzer runs on one thread. */
  private byte[] luminance = new byte[0];

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Asked for before this opens (ScannerPlugin), but it can be switched off
    // in Settings while the app is in the background.
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
      finishWith(RESULT_DENIED, null);
      return;
    }
    drawBehindSystemBars();
    setContentView(layout());
    frames = Executors.newSingleThreadExecutor();
    ListenableFuture<ProcessCameraProvider> provider = ProcessCameraProvider.getInstance(this);
    provider.addListener(() -> {
      try {
        start(provider.get());
      } catch (Exception e) {
        finishWith(RESULT_FAILED, null);
      }
    }, ContextCompat.getMainExecutor(this));
  }

  @Override
  protected void onDestroy() {
    super.onDestroy();
    // The camera itself is let go with this activity's lifecycle.
    if (frames != null) frames.shutdown();
  }

  private void start(ProcessCameraProvider provider) throws Exception {
    if (done.get() || isFinishing() || isDestroyed()) return;
    CameraSelector lens;
    if (provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
      lens = CameraSelector.DEFAULT_BACK_CAMERA;
    } else if (provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) {
      // A tablet or Chromebook with a camera only on the screen side.
      lens = CameraSelector.DEFAULT_FRONT_CAMERA;
    } else {
      finishWith(RESULT_UNAVAILABLE, null);
      return;
    }
    Preview preview = new Preview.Builder().build();
    preview.setSurfaceProvider(picture.getSurfaceProvider());
    // Enough detail for a poster across a room, and no more: every frame is
    // read on the phone, and the latest one is all that matters.
    ImageAnalysis analysis = new ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .setResolutionSelector(new ResolutionSelector.Builder()
            .setResolutionStrategy(new ResolutionStrategy(
                new Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
            .build())
        .build();
    QrFrameReader reader = new QrFrameReader();
    analysis.setAnalyzer(frames, image -> read(reader, image));
    provider.unbindAll();
    camera = provider.bindToLifecycle(this, lens, preview, analysis);
    camera.getCameraInfo().getCameraState().observe(this, state -> {
      CameraState.StateError error = state.getError();
      // Recoverable errors (another app has the camera) CameraX retries.
      if (error == null || error.getType() != CameraState.ErrorType.CRITICAL) return;
      finishWith(
          error.getCode() == CameraState.ERROR_CAMERA_DISABLED ? RESULT_UNAVAILABLE : RESULT_FAILED,
          null);
    });
    if (camera.getCameraInfo().hasFlashUnit()) torch.setVisibility(View.VISIBLE);
  }

  private void read(QrFrameReader reader, ImageProxy image) {
    try {
      if (done.get()) return;
      // The luminance plane: one byte a pixel, rows rowStride apart.
      ImageProxy.PlaneProxy plane = image.getPlanes()[0];
      ByteBuffer buffer = plane.getBuffer();
      int length = buffer.remaining();
      if (luminance.length < length) luminance = new byte[length];
      buffer.get(luminance, 0, length);
      String text = reader.read(luminance, plane.getRowStride(), image.getWidth(), image.getHeight());
      if (text != null) runOnUiThread(() -> finishWith(RESULT_OK, text));
    } finally {
      image.close();
    }
  }

  private void finishWith(int result, String text) {
    if (!done.compareAndSet(false, true)) return;
    if (text != null && picture != null) {
      picture.performHapticFeedback(
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
              ? HapticFeedbackConstants.CONFIRM
              : HapticFeedbackConstants.VIRTUAL_KEY);
    }
    setResult(result, text == null ? null : new Intent().putExtra(EXTRA_TEXT, text));
    finish();
  }

  private void toggleTorch() {
    if (camera == null) return;
    torchOn = !torchOn;
    camera.getCameraControl().enableTorch(torchOn);
    torch.setText(torchOn ? R.string.scanner_torch_off : R.string.scanner_torch_on);
  }

  /**
   * The picture to every edge, with the words kept clear of the status bar,
   * the navigation bar and any cutout. Android 15 and later draw an app this
   * way whatever it asks; this does the same on older phones, so the screen
   * is the same everywhere. Light icons: the bars sit over the dark scrim.
   */
  @SuppressWarnings("deprecation")
  private void drawBehindSystemBars() {
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      getWindow().setStatusBarColor(Color.TRANSPARENT);
      getWindow().setNavigationBarColor(Color.TRANSPARENT);
    }
    WindowInsetsControllerCompat bars =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    bars.setAppearanceLightStatusBars(false);
    bars.setAppearanceLightNavigationBars(false);
  }

  private View layout() {
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    picture = new PreviewView(this);
    root.addView(picture, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    LinearLayout top = new LinearLayout(this);
    top.setOrientation(LinearLayout.HORIZONTAL);
    top.setGravity(Gravity.CENTER_VERTICAL);
    top.setBackgroundColor(SCRIM);
    Button cancel = button(R.string.scanner_cancel);
    cancel.setOnClickListener(v -> finishWith(RESULT_CANCELED, null));
    top.addView(cancel);
    TextView title = words(R.string.scanner_title, 18);
    ViewCompat.setAccessibilityHeading(title, true);
    top.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    root.addView(top, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));

    LinearLayout bottom = new LinearLayout(this);
    bottom.setOrientation(LinearLayout.VERTICAL);
    bottom.setGravity(Gravity.CENTER_HORIZONTAL);
    bottom.setBackgroundColor(SCRIM);
    TextView hint = words(R.string.scanner_hint, 16);
    hint.setGravity(Gravity.CENTER);
    bottom.addView(hint);
    // A poster in a dark tent needs light on it. Shown once the camera says
    // it has a flash to use.
    torch = button(R.string.scanner_torch_on);
    torch.setVisibility(View.GONE);
    torch.setOnClickListener(v -> toggleTorch());
    bottom.addView(torch);
    root.addView(bottom, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

    int gap = dp(12);
    ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
      Insets clear = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
      top.setPadding(clear.left + gap, clear.top + gap / 2, clear.right + gap, gap / 2);
      bottom.setPadding(clear.left + gap, gap, clear.right + gap, clear.bottom + gap);
      return insets;
    });
    return root;
  }

  private TextView words(int text, int sp) {
    TextView view = new TextView(this);
    view.setText(text);
    view.setTextColor(Color.WHITE);
    view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
    return view;
  }

  private Button button(int text) {
    Button button = new Button(this);
    button.setText(text);
    button.setAllCaps(false);
    button.setTextColor(Color.WHITE);
    button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
    button.setBackgroundColor(Color.TRANSPARENT);
    button.setMinHeight(dp(48));
    button.setMinimumHeight(dp(48));
    return button;
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }
}
