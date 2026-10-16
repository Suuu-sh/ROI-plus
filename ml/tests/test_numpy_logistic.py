import pickle

import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression

from edgelab.models.numpy_logistic import (NumpyImputedLogisticRegression,
                                           NumpyLogisticRegression)


@pytest.mark.parametrize("seed", [11, 29])
def test_matches_sklearn_convex_objective_on_pairwise_like_data(seed):
    rng = np.random.default_rng(seed)
    # Nineteen pairwise-style columns, including correlated and constant
    # columns; all features are finite (upstream imputes missing values).
    x = rng.normal(size=(420, 19))
    x[:, 1] = 0.7 * x[:, 0] + rng.normal(scale=0.4, size=x.shape[0])
    x[:, 18] = 0.0
    logits = x @ rng.normal(scale=0.3, size=19)
    y = (rng.random(x.shape[0]) < 1.0 / (1.0 + np.exp(-logits))).astype(int)
    assert np.unique(y).size == 2

    actual = NumpyLogisticRegression(C=0.25, max_iter=1000, tol=1e-10).fit(x, y)
    reference = LogisticRegression(C=0.25, fit_intercept=False, max_iter=1000,
                                   solver="lbfgs", random_state=17, tol=1e-12).fit(x, y)
    default_reference = LogisticRegression(C=0.25, fit_intercept=False, max_iter=1000,
                                           solver="lbfgs", random_state=17).fit(x, y)

    coefficient_delta = np.max(np.abs(actual.coef_ - reference.coef_))
    actual_probabilities = actual.predict_proba(x)
    reference_probabilities = reference.predict_proba(x)
    probability_delta = np.max(np.abs(actual_probabilities - reference_probabilities))
    default_coefficient_delta = np.max(np.abs(actual.coef_ - default_reference.coef_))
    default_probability_delta = np.max(
        np.abs(actual_probabilities - default_reference.predict_proba(x)))
    assert actual.coef_.shape == (1, 19)
    assert actual.converged_ and actual.gradient_norm_ <= 1e-10
    assert coefficient_delta < 2e-7
    assert probability_delta < 2e-7
    # The production reference uses sklearn's default tol=1e-4. Its returned
    # iterate is consequently less converged than our stated optimum; parity is
    # close but deliberately not asserted bitwise.
    assert default_coefficient_delta < 4e-4
    assert default_probability_delta < 4e-4

    # Check the exact summed-loss convention independently of optimizer state.
    z = x @ actual.coef_[0]
    expected_objective = np.sum(np.logaddexp(0.0, z) - y * z) + np.sum(actual.coef_[0] ** 2) / 0.5
    assert actual.objective_ == pytest.approx(expected_objective, abs=1e-10)
    restored = pickle.loads(pickle.dumps(actual))
    np.testing.assert_array_equal(restored.predict_proba(x), actual_probabilities)


def test_constant_columns_and_extreme_finite_inputs_remain_stable():
    x = np.array([
        [1e6, 1.0, 0.0], [-1e6, 1.0, 0.0], [8e5, 1.0, 0.0],
        [-8e5, 1.0, 0.0], [4e5, 1.0, 0.0], [-4e5, 1.0, 0.0],
    ])
    y = np.array([1, 0, 1, 0, 1, 0])
    # Large-magnitude columns create a deliberately ill-conditioned Hessian;
    # keep the gradient criterion strong while allowing double-precision
    # cancellation in the projected gradient.
    fitted = NumpyLogisticRegression(max_iter=1000, tol=1e-8).fit(x, y)
    probabilities = fitted.predict_proba(x)
    assert np.isfinite(fitted.coef_).all()
    assert np.isfinite(probabilities).all()
    assert np.all((probabilities >= 0.0) & (probabilities <= 1.0))
    assert fitted.gradient_norm_ <= 1e-8
    assert fitted.coef_[0, 2] == pytest.approx(0.0, abs=1e-12)


@pytest.mark.parametrize("x,y", [
    (np.ones(3), np.array([0, 1, 0])),
    (np.ones((3, 2)), np.array([0, 1])),
    (np.array([[0.0], [np.nan]]), np.array([0, 1])),
    (np.ones((3, 1)), np.array([1, 1, 1])),
    (np.ones((2, 1)), np.array([0.0, np.nan])),
    (np.ones((2, 1)), np.array([0.0, np.inf])),
    (np.ones((2, 1)), np.array([0, None], dtype=object)),
])
def test_rejects_invalid_training_inputs(x, y):
    with pytest.raises(ValueError):
        NumpyLogisticRegression().fit(x, y)


def test_rejects_nonconvergence_instead_of_silently_returning_estimate():
    x = np.array([[-2.0], [-1.0], [1.0], [2.0]])
    y = np.array([0, 0, 1, 1])
    with pytest.raises(RuntimeError, match="did not converge"):
        NumpyLogisticRegression(max_iter=1, tol=1e-14).fit(x, y)


def test_imputed_wrapper_fits_training_only_statistics_and_reuses_them_for_inference():
    x = np.array([
        [1.0, np.nan, 0.0], [2.0, 2.0, 0.0], [3.0, None, 0.0],
        [np.nan, 4.0, 0.0], [5.0, 5.0, 0.0], [6.0, 6.0, 0.0],
    ], dtype=object)
    y = np.array([0, 1, 0, 0, 1, 1])
    fitted = NumpyImputedLogisticRegression().fit(x, y)
    assert fitted.medians_.shape == fitted.means_.shape == fitted.scales_.shape == (3,)
    np.testing.assert_allclose(fitted.medians_, [3.0, 4.5, 0.0])
    assert fitted.scales_[2] == 1.0
    assert fitted.converged_ and fitted.gradient_norm_ <= 1e-8

    held_out = np.array([[np.nan, 3.5, 0.0], [1000.0, np.inf, 0.0]])
    before = tuple(array.copy() for array in
                   (fitted.medians_, fitted.means_, fitted.scales_))
    probabilities = fitted.predict_proba(held_out)
    assert probabilities.shape == (2, 2) and np.isfinite(probabilities).all()
    for original, current in zip(before,
                                 (fitted.medians_, fitted.means_, fitted.scales_)):
        np.testing.assert_array_equal(current, original)

    restored = pickle.loads(pickle.dumps(fitted))
    np.testing.assert_array_equal(restored.predict_proba(held_out), probabilities)


def test_finite_only_estimator_still_rejects_missing_values():
    with pytest.raises(ValueError, match="finite"):
        NumpyLogisticRegression().fit(
            np.array([[0.0], [np.nan], [1.0], [2.0]]), np.array([0, 0, 1, 1]))

