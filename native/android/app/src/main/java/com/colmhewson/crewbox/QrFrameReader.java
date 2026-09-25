package com.colmhewson.crewbox;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/**
 * The text of a QR code in one camera frame, for {@link ScannerActivity}.
 *
 * ZXing, on the phone. A frame is the luminance plane the camera hands over,
 * rows {@code rowStride} bytes apart, of which the first {@code width} of each
 * are the picture. QR codes only: the join poster prints nothing else, and
 * the page makes sense of the text.
 *
 * Also read light-on-dark: a box's console draws its QR in the terminal's
 * text colour, which comes out that way round on a terminal with dark text
 * on a light background. One reader per thread: ZXing's readers keep state.
 */
final class QrFrameReader {

  private final MultiFormatReader reader = new MultiFormatReader();

  QrFrameReader() {
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    hints.put(DecodeHintType.ALSO_INVERTED, Boolean.TRUE);
    reader.setHints(hints);
  }

  /** The code's text, or null when the frame has no QR code with text in it. */
  String read(byte[] luminance, int rowStride, int width, int height) {
    // The last row need not be padded out to the stride.
    if (width <= 0 || height <= 0 || rowStride < width
        || luminance.length < (long) rowStride * (height - 1) + width) {
      return null;
    }
    PlanarYUVLuminanceSource source =
        new PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false);
    try {
      Result result = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
      String text = result.getText();
      return text == null || text.isEmpty() ? null : text;
    } catch (NotFoundException e) {
      return null;
    } finally {
      reader.reset();
    }
  }
}
